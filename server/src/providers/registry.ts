import type { Db } from "../db.ts";
import type { SecretBox } from "../secrets.ts";
import { AppError, newId, nowIso, randomToken, safeJsonParse } from "../util.ts";
import { MockProvider } from "./mock.ts";
import { DEFAULT_BYTEPLUS_ENDPOINT, SeedanceBytePlusProvider } from "./seedance.ts";
import type { ProviderCapabilities, ResolvedProviderConfig, VideoProvider } from "./types.ts";
import type { MediaTools } from "../media.ts";

/**
 * Video Provider Registry: adapter theo provider_type + cấu hình theo workspace
 * (bảng video_provider_configurations). Secret chỉ giải mã khi gọi provider.
 */
export const PROVIDER_TYPES = [
  {
    type: "seedance-byteplus",
    label: "Seedance - BytePlus ModelArk",
    authType: "bearer-api-key",
    defaultEndpoint: DEFAULT_BYTEPLUS_ENDPOINT,
    defaultModels: ["dreamina-seedance-2-5-260628", "dreamina-seedance-2-0-260128"],
    defaultConcurrency: 2,
    defaultRpm: 30,
  },
  {
    type: "mock",
    label: "Mock (kiểm thử, không tính phí)",
    authType: "none",
    defaultEndpoint: "",
    defaultModels: ["mock-standard", "mock-short"],
    defaultConcurrency: 2,
    defaultRpm: 600,
  },
] as const;

export interface ProviderConfigRow {
  id: string;
  workspace_id: string;
  provider_type: string;
  name: string;
  endpoint: string;
  auth_type: string;
  model_ids_json: string;
  default_model_id: string | null;
  enabled: number;
  max_concurrency: number;
  requests_per_minute: number;
  options_json: string;
  secret_enc: string | null;
  webhook_secret_enc: string | null;
  last_test_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Dạng trả về API - KHÔNG BAO GIỜ có secret, chỉ cờ "đã đặt" */
export interface ProviderConfigPublic {
  id: string;
  providerType: string;
  name: string;
  endpoint: string;
  authType: string;
  modelIds: string[];
  defaultModelId: string | null;
  enabled: boolean;
  maxConcurrency: number;
  requestsPerMinute: number;
  options: Record<string, unknown>;
  hasApiKey: boolean;
  webhookEnabled: boolean;
  lastTest: { ok: boolean; message: string; at: string } | null;
  status: "active" | "disabled" | "needs_key";
  capabilities: ProviderCapabilities;
  createdAt: string;
  updatedAt: string;
}

export class ProviderRegistry {
  private db: Db;
  private secrets: SecretBox;
  private adapters = new Map<string, VideoProvider>();
  private publicBaseUrl: string;

  constructor(db: Db, secrets: SecretBox, media: MediaTools, opts: { publicBaseUrl: string; fetchImpl?: typeof fetch }) {
    this.db = db;
    this.secrets = secrets;
    this.publicBaseUrl = opts.publicBaseUrl;
    this.register(new MockProvider(db, media));
    this.register(new SeedanceBytePlusProvider(opts.fetchImpl ?? fetch));
  }

  register(p: VideoProvider): void {
    this.adapters.set(p.type, p);
  }

  adapter(type: string): VideoProvider {
    const a = this.adapters.get(type);
    if (!a) throw new AppError("PROVIDER_TYPE_UNKNOWN", `Không có adapter cho provider "${type}".`, 400);
    return a;
  }

  private row(workspaceId: string, id: string): ProviderConfigRow {
    const r = this.db.get<ProviderConfigRow>("SELECT * FROM video_provider_configurations WHERE id = ? AND workspace_id = ?", id, workspaceId);
    if (!r) throw new AppError("NOT_FOUND", "Không tìm thấy cấu hình provider.", 404);
    return r;
  }

  rowById(id: string): ProviderConfigRow | undefined {
    return this.db.get<ProviderConfigRow>("SELECT * FROM video_provider_configurations WHERE id = ?", id);
  }

  resolve(row: ProviderConfigRow): ResolvedProviderConfig {
    let webhookUrl: string | null = null;
    if (row.webhook_secret_enc && this.publicBaseUrl) {
      webhookUrl = `${this.publicBaseUrl}/api/webhooks/provider/${row.id}/${this.secrets.decrypt(row.webhook_secret_enc)}`;
    }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      providerType: row.provider_type,
      name: row.name,
      endpoint: row.endpoint,
      modelIds: safeJsonParse<string[]>(row.model_ids_json, []),
      defaultModelId: row.default_model_id,
      maxConcurrency: row.max_concurrency,
      requestsPerMinute: row.requests_per_minute,
      options: safeJsonParse<Record<string, unknown>>(row.options_json, {}),
      apiKey: row.secret_enc ? this.secrets.decrypt(row.secret_enc) : "",
      webhookUrl,
    };
  }

  resolveById(workspaceId: string, id: string): { row: ProviderConfigRow; config: ResolvedProviderConfig; adapter: VideoProvider } {
    const row = this.row(workspaceId, id);
    return { row, config: this.resolve(row), adapter: this.adapter(row.provider_type) };
  }

  toPublic(row: ProviderConfigRow): ProviderConfigPublic {
    const adapter = this.adapter(row.provider_type);
    const needsKey = row.auth_type !== "none" && !row.secret_enc;
    // capabilities không cần secret
    const resolvedNoSecret: ResolvedProviderConfig = {
      id: row.id,
      workspaceId: row.workspace_id,
      providerType: row.provider_type,
      name: row.name,
      endpoint: row.endpoint,
      modelIds: safeJsonParse<string[]>(row.model_ids_json, []),
      defaultModelId: row.default_model_id,
      maxConcurrency: row.max_concurrency,
      requestsPerMinute: row.requests_per_minute,
      options: safeJsonParse(row.options_json, {}),
      apiKey: "",
      webhookUrl: null,
    };
    return {
      id: row.id,
      providerType: row.provider_type,
      name: row.name,
      endpoint: row.endpoint,
      authType: row.auth_type,
      modelIds: resolvedNoSecret.modelIds,
      defaultModelId: row.default_model_id,
      enabled: Boolean(row.enabled),
      maxConcurrency: row.max_concurrency,
      requestsPerMinute: row.requests_per_minute,
      options: resolvedNoSecret.options,
      hasApiKey: Boolean(row.secret_enc),
      webhookEnabled: Boolean(row.webhook_secret_enc),
      lastTest: safeJsonParse(row.last_test_json, null),
      status: !row.enabled ? "disabled" : needsKey ? "needs_key" : "active",
      capabilities: adapter.getCapabilities(resolvedNoSecret),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(workspaceId: string): ProviderConfigPublic[] {
    return this.db
      .all<ProviderConfigRow>("SELECT * FROM video_provider_configurations WHERE workspace_id = ? ORDER BY created_at", workspaceId)
      .map((r) => this.toPublic(r));
  }

  get(workspaceId: string, id: string): ProviderConfigPublic {
    return this.toPublic(this.row(workspaceId, id));
  }

  create(
    workspaceId: string,
    input: {
      providerType: string;
      name?: string;
      endpoint?: string;
      modelIds?: string[];
      defaultModelId?: string | null;
      maxConcurrency?: number;
      requestsPerMinute?: number;
      options?: Record<string, unknown>;
      apiKey?: string;
      enableWebhook?: boolean;
      enabled?: boolean;
    },
  ): ProviderConfigPublic {
    const meta = PROVIDER_TYPES.find((t) => t.type === input.providerType);
    if (!meta) throw new AppError("PROVIDER_TYPE_UNKNOWN", `Loại provider "${input.providerType}" không được hỗ trợ.`, 400);
    const id = newId("prv");
    const now = nowIso();
    const models = input.modelIds?.length ? input.modelIds : [...meta.defaultModels];
    this.db.run(
      `INSERT INTO video_provider_configurations (id, workspace_id, provider_type, name, endpoint, auth_type, model_ids_json, default_model_id,
        enabled, max_concurrency, requests_per_minute, options_json, secret_enc, webhook_secret_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workspaceId,
      meta.type,
      input.name?.trim() || meta.label,
      input.endpoint?.trim() || meta.defaultEndpoint,
      meta.authType,
      JSON.stringify(models),
      input.defaultModelId ?? models[0] ?? null,
      input.enabled === false ? 0 : 1,
      clampInt(input.maxConcurrency ?? meta.defaultConcurrency, 1, 64),
      clampInt(input.requestsPerMinute ?? meta.defaultRpm, 1, 10_000),
      JSON.stringify(input.options ?? {}),
      input.apiKey ? this.secrets.encrypt(input.apiKey.trim()) : null,
      input.enableWebhook ? this.secrets.encrypt(randomToken(24)) : null,
      now,
      now,
    );
    return this.get(workspaceId, id);
  }

  update(
    workspaceId: string,
    id: string,
    patch: {
      name?: string;
      endpoint?: string;
      modelIds?: string[];
      defaultModelId?: string | null;
      maxConcurrency?: number;
      requestsPerMinute?: number;
      options?: Record<string, unknown>;
      apiKey?: string | null;
      enableWebhook?: boolean;
      enabled?: boolean;
    },
  ): ProviderConfigPublic {
    const row = this.row(workspaceId, id);
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.name !== undefined) set("name", patch.name.trim() || row.name);
    if (patch.endpoint !== undefined) set("endpoint", patch.endpoint.trim());
    if (patch.modelIds !== undefined) set("model_ids_json", JSON.stringify(patch.modelIds.map((m) => m.trim()).filter(Boolean)));
    if (patch.defaultModelId !== undefined) set("default_model_id", patch.defaultModelId);
    if (patch.maxConcurrency !== undefined) set("max_concurrency", clampInt(patch.maxConcurrency, 1, 64));
    if (patch.requestsPerMinute !== undefined) set("requests_per_minute", clampInt(patch.requestsPerMinute, 1, 10_000));
    if (patch.options !== undefined) set("options_json", JSON.stringify(patch.options));
    if (patch.apiKey !== undefined) set("secret_enc", patch.apiKey ? this.secrets.encrypt(patch.apiKey.trim()) : null);
    if (patch.enableWebhook !== undefined) set("webhook_secret_enc", patch.enableWebhook ? (row.webhook_secret_enc ?? this.secrets.encrypt(randomToken(24))) : null);
    if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
    if (sets.length) {
      set("updated_at", nowIso());
      this.db.run(`UPDATE video_provider_configurations SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`, ...vals, id, workspaceId);
    }
    return this.get(workspaceId, id);
  }

  remove(workspaceId: string, id: string): void {
    this.row(workspaceId, id);
    const active = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM video_batch_jobs WHERE provider_config_id = ? AND status IN ('queued','waiting_for_capacity','submitting','processing')",
      id,
    );
    if (Number(active?.n ?? 0) > 0) throw new AppError("PROVIDER_IN_USE", "Provider đang có job chạy - tạm dừng/hủy batch trước khi xóa.", 409);
    this.db.run("UPDATE video_provider_configurations SET enabled = 0, updated_at = ? WHERE id = ?", nowIso(), id);
  }

  async test(workspaceId: string, id: string): Promise<{ ok: boolean; message: string }> {
    const { config, adapter } = this.resolveById(workspaceId, id);
    const result = adapter.testConnection
      ? await adapter.testConnection({ config, idempotencyKey: "test", workDir: "", log: () => {} })
      : { ok: false, message: "Provider không có chức năng kiểm tra kết nối." };
    this.db.run("UPDATE video_provider_configurations SET last_test_json = ?, updated_at = ? WHERE id = ?", JSON.stringify({ ...result, at: nowIso() }), nowIso(), id);
    return result;
  }

  /** Bảo đảm workspace có sẵn một Mock provider để thử ngay (không tốn tiền) */
  ensureMock(workspaceId: string): void {
    const has = this.db.get("SELECT 1 AS x FROM video_provider_configurations WHERE workspace_id = ? AND provider_type = 'mock'", workspaceId);
    if (!has) this.create(workspaceId, { providerType: "mock", name: "Mock (kiểm thử, không tính phí)", options: { latencyMs: 4000 } });
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
