/**
 * Client REST cho Batch Video Studio - kiểu dữ liệu bám sát docs/API.md.
 * Mọi request ghi gửi X-BVS-Request: 1 (chống CSRF) + Content-Type JSON.
 */

// ------------------------------------------------------------------ kiểu chung

export type JobStatus =
  | "draft"
  | "awaiting_approval"
  | "queued"
  | "waiting_for_capacity"
  | "submitting"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

export const JOB_STATUSES: JobStatus[] = ["draft", "awaiting_approval", "queued", "waiting_for_capacity", "submitting", "processing", "completed", "failed", "cancelled"];
export const ACTIVE_JOB_STATUSES: JobStatus[] = ["submitting", "processing"];
export const PENDING_JOB_STATUSES: JobStatus[] = ["draft", "awaiting_approval", "queued", "waiting_for_capacity"];
export const TERMINAL_JOB_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

export type BatchStatus = "draft" | "awaiting_approval" | "running" | "paused" | "completed" | "cancelled";
export type GenerationMode = "text-to-video" | "image-to-video" | "reference-to-video";
export type PricingKind = "free-mock" | "user-configured" | "unknown";

export interface User {
  id: string;
  username: string;
  role: string;
}

export interface Me {
  user: User;
  via: string;
  workspaceId: string;
  workspaces: { id: string; name: string; role: string }[];
}

export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface LlmSettings {
  baseUrl: string;
  textModel: string;
  visionModel: string;
  audioModel: string;
  hasApiKey: boolean;
  updatedAt: string | null;
}

export interface SystemInfo {
  workerMode: string;
  editInboxConfigured: boolean;
  webhookBaseConfigured: boolean;
}

export interface AuditEntry {
  id: number;
  user_id: string | null;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  data_json: string | null;
  created_at: string;
}

// ------------------------------------------------------------------ provider

export interface ModelCaps {
  modelId: string;
  label: string;
  verified: boolean;
  modes: GenerationMode[];
  durations: { min: number; max: number; auto: boolean };
  aspectRatios: string[];
  resolutions: string[];
  defaultResolution: string;
  audio: boolean;
  negativePrompt: boolean;
  maxPromptChars: number;
  maxReferenceImages: number;
  qualityModes: string[];
  seed: boolean;
  notes: string[];
}

export interface ProviderCaps {
  providerType: string;
  label: string;
  cancel: "none" | "queued_only" | "any";
  idempotency: boolean;
  progress: boolean;
  webhook: boolean;
  concurrencyHint: string | null;
  pricing: PricingKind;
  docsUrl: string | null;
  models: ModelCaps[];
}

export interface ProviderOptions {
  pricePerSecond?: Record<string, number>;
  pricePerMillionTokens?: number;
  currency?: string;
  latencyMs?: number;
  pollIntervalMs?: number;
  watermark?: boolean;
  [key: string]: unknown;
}

export interface ProviderConfig {
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
  options: ProviderOptions;
  hasApiKey: boolean;
  webhookEnabled: boolean;
  lastTest: { ok: boolean; message: string; at: string } | null;
  status: "active" | "disabled" | "needs_key";
  capabilities: ProviderCaps;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderType {
  type: string;
  label: string;
  authType: string;
  defaultEndpoint: string;
  defaultModels: string[];
  defaultConcurrency: number;
  defaultRpm: number;
}

export interface ProviderInput {
  providerType?: string;
  name?: string;
  endpoint?: string;
  modelIds?: string[];
  defaultModelId?: string | null;
  maxConcurrency?: number;
  requestsPerMinute?: number;
  options?: ProviderOptions;
  apiKey?: string | null;
  enableWebhook?: boolean;
  enabled?: boolean;
}

// ------------------------------------------------------------------ phiên, skill, chat

export interface Session {
  id: string;
  title: string;
  skillMode: "auto" | "manual" | "none";
  skillIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  genres: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[] | null;
  toolCallId: string | null;
  toolName: string | null;
  createdAt: string;
}

export interface ChatSendBody {
  message: string;
  mode?: "auto" | "manual";
  skillIds?: string[];
  providerConfigId?: string;
  modelId?: string;
  attachments?: { assetIds?: string[]; text?: { fileName: string; content: string } };
}

// ------------------------------------------------------------------ asset

export interface Asset {
  id: string;
  sessionId: string | null;
  kind: "reference" | "image" | "generated";
  origin: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  hasAudio: boolean | null;
  inLibrary: boolean;
  sourceJobId: string | null;
  urls: { file: string; preview: string; thumbnail: string; download: string };
  createdAt: string;
}

export interface LibraryItem extends Asset {
  batchId: string | null;
  batchName: string | null;
  sessionTitle: string | null;
  version: number | null;
  prompt: string | null;
}

// ------------------------------------------------------------------ prompt

export interface PromptDraft {
  prompt: string;
  title?: string;
  objective?: string;
  negative?: string | null;
  durationSec?: number | null;
  aspectRatio?: string | null;
}

export interface ParseResult {
  format: "txt" | "csv" | "json";
  items: { line: number; draft: PromptDraft }[];
  blankLines: number[];
  errors: { line: number; message: string }[];
  check: {
    totalLines: number;
    blankLines: number[];
    duplicates: { line: number; duplicateOfLine: number }[];
    nearDuplicates: { line: number; similarToLine: number; score: number }[];
    uniqueLines: number[];
  };
  summary: string;
}

export interface PromptInput {
  prompt: string;
  title?: string;
  negative?: string | null;
  durationSec?: number | null;
  aspectRatio?: string | null;
  referenceAssetIds?: string[];
  promptItemId?: string;
}

export type Approval = "pending" | "approved" | "rejected";

export interface PromptItem {
  id: string;
  setId: string;
  index: number;
  title: string;
  objective: string;
  prompt: string;
  negative: string | null;
  model: string | null;
  durationSec: number | null;
  aspectRatio: string | null;
  genre: string | null;
  referenceAssetIds: string[];
  approval: Approval;
}

export interface PromptSetCounts {
  total: number;
  approved: number;
  rejected: number;
}

export interface PromptSet {
  id: string;
  sessionId: string | null;
  name: string;
  source: "ai" | "import" | "manual" | string;
  params: Record<string, unknown>;
  items: PromptItem[];
  counts: PromptSetCounts;
  createdAt: string;
}

export interface PromptSetSummary {
  id: string;
  name: string;
  source: string;
  counts: PromptSetCounts;
  createdAt: string;
}

export interface GenerateBody {
  sessionId?: string | null;
  count: number;
  durationSec: number;
  aspectRatio: string;
  providerConfigId: string;
  modelId: string;
  genres?: string[];
  brief?: string;
  consistency?: { product?: string; brand?: string; character?: string };
  referenceAssetIds?: string[];
  language?: "vi" | "en";
  name?: string;
}

export interface GenerateResult {
  set: PromptSet;
  requested: number;
  generated: number;
  shortfall: number;
  duplicatesRemoved: number;
  nearDuplicates: { line: number; similarToLine: number; score: number }[];
  message: string;
}

// ------------------------------------------------------------------ batch + job

export interface BatchConfig {
  mode: GenerationMode;
  durationSec: number;
  aspectRatio: string;
  resolution: string;
  audio: boolean;
  quality: string | null;
  variantsPerPrompt: number;
  referenceAssetIds: string[];
  maxAttempts: number;
}

export interface Issue {
  field: string;
  code: string;
  message: string;
}

export interface BatchCheck {
  totalLines: number;
  blankLines: number[];
  validPrompts: number;
  invalidPrompts: number;
  duplicateCount: number;
  nearDuplicates: { line: number; similarToLine: number; score: number }[];
  variantsPerPrompt: number;
  jobCount: number;
  summary: string;
  items: { index: number; line: number | null; prompt: string; issues: Issue[]; duplicateOf: number | null; valid: boolean }[];
  batchIssues: Issue[];
  ok: boolean;
}

export interface BatchEstimate {
  jobCount: number;
  total: number | null;
  currency: string;
  kind: PricingKind;
  basis: string;
  budgetLimit: number | null;
  withinBudget: boolean | null;
  effectiveConcurrency: number;
  providerConcurrency: number;
  notes: string[];
}

export interface Batch {
  id: string;
  sessionId: string | null;
  name: string;
  mode: string;
  promptSetId: string | null;
  providerConfigId: string;
  providerName: string | null;
  providerType: string | null;
  modelId: string;
  config: BatchConfig;
  maxConcurrency: number;
  status: BatchStatus;
  budgetLimit: number | null;
  estimate: BatchEstimate | null;
  estimatedCost: number | null;
  actualCost: number | null;
  committedCost: number | null;
  currency: string;
  approvedAt: string | null;
  counts: Partial<Record<JobStatus, number>>;
  total: number;
  progress: number;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRequest {
  name?: string;
  sessionId?: string | null;
  mode?: "single" | "list" | "file" | "ai";
  promptSetId?: string | null;
  providerConfigId: string;
  modelId: string;
  config: BatchConfig;
  prompts: PromptInput[];
  maxConcurrency: number;
  budgetLimit?: number | null;
  blankLines?: number[];
  lines?: (number | null)[];
}

export interface CostConfirm {
  confirm: true;
  approvedMaxCost?: number;
  acknowledgeUnknownCost?: boolean;
}

export type DeploySelection = "auto" | "approved" | "all";

export interface DeployBody {
  sessionId?: string | null;
  providerConfigId?: string;
  modelId?: string;
  config?: Partial<BatchConfig>;
  selection?: DeploySelection;
  useItemOverrides?: boolean;
  defaultNegative?: string | null;
  maxConcurrency?: number;
  budgetLimit?: number | null;
  name?: string;
  dryRun?: boolean;
  run?: { confirm: true; approvedMaxCost?: number | null; acknowledgeUnknownCost?: boolean };
}

export interface DeployResult {
  dryRun: boolean;
  promptSetId: string;
  promptSetName: string;
  selection: DeploySelection;
  promptCount: number;
  videoCount: number;
  promptIndexes: number[];
  providerConfigId: string;
  modelId: string;
  free: boolean;
  check: BatchCheck;
  estimate: BatchEstimate;
  batch: Batch | null;
  approved: boolean;
  approveError: { code: string; message: string } | null;
}

export interface Job {
  id: string;
  batchId: string;
  sessionId: string | null;
  seq: number;
  title: string;
  prompt: string;
  negative: string | null;
  referenceAssetIds: string[];
  providerConfigId: string;
  providerName: string | null;
  modelId: string;
  config: BatchConfig;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  remoteJobId: string | null;
  progress: number | null;
  cancelRequested: boolean;
  error: { code: string | null; message: string | null; detail: string | null } | null;
  nextAttemptAt: string | null;
  outputAssetId: string | null;
  output: { assetId: string; thumbnail: string | null; preview: string; download: string; durationSec: number | null } | null;
  estimatedCost: number | null;
  actualCost: number | null;
  lineageId: string;
  version: number;
  parentJobId: string | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

/** Dòng job_events thô (GET /api/jobs/:id/events, /api/batches/:id/events) */
export interface JobEventRow {
  id: number;
  type: string;
  batch_id: string | null;
  job_id: string | null;
  from_status: string | null;
  to_status: string | null;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

/** Sự kiện SSE /api/events */
export interface RealtimeEvent {
  id: number;
  type: string;
  batchId: string | null;
  jobId: string | null;
  from: string | null;
  to: string | null;
  message: string | null;
  data: Record<string, unknown> | null;
  at: string;
}

// ------------------------------------------------------------------ client

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;
  constructor(code: string, message: string, status: number, details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError("CLIENT_ERROR", e instanceof Error ? e.message : String(e), 0);
}

let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

const WRITE_HEADERS = { "Content-Type": "application/json", "X-BVS-Request": "1" } as const;

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } } | null;

async function toApiError(res: Response): Promise<ApiError> {
  let body: ErrorBody = null;
  try {
    body = (await res.json()) as ErrorBody;
  } catch {
    body = null;
  }
  const err = new ApiError(body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? `Máy chủ trả lỗi HTTP ${res.status}.`, res.status, body?.error?.details ?? null);
  if (res.status === 401 && err.code === "UNAUTHORIZED") unauthorizedHandler?.();
  return err;
}

async function rawFetch(method: string, url: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, credentials: "same-origin" };
  if (method !== "GET") {
    init.headers = { ...WRITE_HEADERS };
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError("NETWORK", "Không kết nối được máy chủ - kiểm tra server đang chạy.", 0);
  }
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await rawFetch(method, url, body);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const get = <T>(url: string) => request<T>("GET", url);
const post = <T>(url: string, body?: unknown) => request<T>("POST", url, body);
const put = <T>(url: string, body?: unknown) => request<T>("PUT", url, body);
const patch = <T>(url: string, body?: unknown) => request<T>("PATCH", url, body);
const del = <T>(url: string) => request<T>("DELETE", url);

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    u.set(k, v === true ? "1" : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : "";
}

export interface FbReelsConfig {
  pageId: string;
  graphVersion: string;
  intervalMin: number;
  autoEnabled: boolean;
  requireApproval: boolean;
  captionTemplate: string;
  hashtags: string;
  aiCaption: boolean;
  enabledSince: string | null;
  tokenConfigured: boolean;
  tokenLast4: string | null;
  updatedAt: string | null;
}

export type FbReelStatus = "pending_review" | "approved" | "publishing" | "published" | "failed" | "skipped" | "rejected" | "removed";

export interface FbReelsPause {
  kind: "token" | "permission";
  message: string;
  at: string;
}

export interface FbReelItem {
  id: string;
  assetId: string;
  status: FbReelStatus;
  statusLabel: string;
  title: string;
  prompt: string;
  fileName: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  skipReason: string | null;
  errorMessage: string | null;
  caption: string | null;
  fbVideoId: string | null;
  attempts: number;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

const enc = encodeURIComponent;

export const api = {
  // auth
  setupStatus: () => get<{ needsSetup: boolean }>("/api/auth/setup-status"),
  setup: (username: string, password: string) => post<{ user: User }>("/api/auth/setup", { username, password }),
  login: (username: string, password: string) => post<{ user: User }>("/api/auth/login", { username, password }),
  logout: () => post<{ ok: boolean }>("/api/auth/logout"),
  me: () => get<Me>("/api/auth/me"),

  // token + cài đặt
  tokens: () => get<{ tokens: ApiToken[] }>("/api/tokens"),
  createToken: (name: string) => post<{ id: string; token: string; note: string }>("/api/tokens", { name }),
  revokeToken: (id: string) => del<{ ok: boolean }>(`/api/tokens/${enc(id)}`),
  fbReelsConfig: () => get<FbReelsConfig>("/api/facebook/reels/config"),
  saveFbReelsConfig: (body: Partial<Omit<FbReelsConfig, "tokenConfigured" | "tokenLast4" | "updatedAt" | "enabledSince">> & { pageToken?: string | null }) => put<FbReelsConfig>("/api/facebook/reels/config", body),
  testFbReels: () => post<{ ok: boolean; pageName?: string; message: string }>("/api/facebook/reels/config/test"),
  fbReelsQueue: () => get<{ items: FbReelItem[]; pause: FbReelsPause | null }>("/api/facebook/reels/queue"),
  fbReelsResume: () => post<{ ok: boolean }>("/api/facebook/reels/resume"),
  fbReelsApprove: (id: string) => post<FbReelItem>(`/api/facebook/reels/queue/${enc(id)}/approve`),
  fbReelsReject: (id: string) => post<{ ok: boolean }>(`/api/facebook/reels/queue/${enc(id)}/reject`),
  fbReelsRetry: (id: string) => post<{ ok: boolean }>(`/api/facebook/reels/queue/${enc(id)}/retry`),
  fbReelsRemove: (id: string) => del<{ ok: boolean }>(`/api/facebook/reels/queue/${enc(id)}`),
  llmSettings: () => get<LlmSettings>("/api/settings/llm"),
  saveLlmSettings: (body: Partial<Omit<LlmSettings, "hasApiKey" | "updatedAt">> & { apiKey?: string | null }) => put<LlmSettings>("/api/settings/llm", body),
  systemInfo: () => get<SystemInfo>("/api/settings/system"),
  audit: () => get<{ entries: AuditEntry[] }>("/api/audit"),

  // provider
  providerTypes: () => get<{ types: ProviderType[] }>("/api/providers/types"),
  providers: () => get<{ providers: ProviderConfig[] }>("/api/providers"),
  createProvider: (body: ProviderInput) => post<ProviderConfig>("/api/providers", body),
  updateProvider: (id: string, body: ProviderInput) => patch<ProviderConfig>(`/api/providers/${enc(id)}`, body),
  disableProvider: (id: string) => del<{ ok: boolean }>(`/api/providers/${enc(id)}`),
  testProvider: (id: string) => post<{ ok: boolean; message: string }>(`/api/providers/${enc(id)}/test`),

  // phiên, skill, chat
  sessions: () => get<{ sessions: Session[] }>("/api/sessions"),
  createSession: (title?: string) => post<Session>("/api/sessions", { title }),
  updateSession: (id: string, body: Partial<Pick<Session, "title" | "skillMode" | "skillIds">>) => patch<Session>(`/api/sessions/${enc(id)}`, body),
  skills: () => get<{ skills: Skill[] }>("/api/skills"),
  chatHistory: (sessionId: string) => get<{ messages: ChatMessage[] }>(`/api/sessions/${enc(sessionId)}/chat`),
  sendChat: (sessionId: string, body: ChatSendBody) => post<{ messages: ChatMessage[] }>(`/api/sessions/${enc(sessionId)}/chat`, body),

  // asset
  assets: (q: { kind?: string; sessionId?: string | null; library?: boolean }) => get<{ assets: Asset[] }>(`/api/assets${qs({ kind: q.kind, sessionId: q.sessionId, library: q.library })}`),
  asset: (id: string) => get<Asset>(`/api/assets/${enc(id)}`),
  setLibrary: (assetIds: string[], inLibrary = true) => post<{ updated: number }>("/api/assets/library", { assetIds, inLibrary }),
  deleteAssets: (assetIds: string[]) => post<{ deleted: string[]; skipped: { id: string; reason: string }[]; freedBytes: number }>("/api/assets/delete", { assetIds }),
  pruneOrphans: () => post<{ removedDirs: number; freedBytes: number }>("/api/assets/prune-orphans"),
  sendToEdit: (id: string) => post<{ path: string }>(`/api/assets/${enc(id)}/send-to-edit`),
  proEditAssets: (assetIds: string[], brief?: string) => post<{ id: string; status: string; message: string }>("/api/assets/pro-edit", { assetIds, brief }),
  proEditStatus: (id: string) => get<{ id: string; status: "running" | "done" | "failed"; message: string; assetId: string | null; error: string | null }>(`/api/assets/pro-edit/${enc(id)}`),
  autoEditAssets: (assetIds: string[], brief?: string) => post<{ asset: Asset; plan: { clips: { id: string }[]; transition: string } }>("/api/assets/auto-edit", { assetIds, brief }),
  mergeAssets: (assetIds: string[], name?: string, sessionId?: string | null) => post<Asset>("/api/assets/merge", { assetIds, name, sessionId }),
  zip: async (assetIds: string[]): Promise<Blob> => (await rawFetch("POST", "/api/assets/zip", { assetIds })).blob(),

  // phân tích

  // prompt
  parsePrompts: (body: { text: string; fileName?: string; format?: "txt" | "csv" | "json" }) => post<ParseResult>("/api/prompts/parse", body),
  promptSets: (sessionId?: string | null) => get<{ sets: PromptSetSummary[] }>(`/api/prompt-sets${qs({ sessionId })}`),
  createPromptSet: (body: { name: string; sessionId?: string | null; items?: PromptInput[]; text?: string; fileName?: string }) => post<PromptSet>("/api/prompt-sets", body),
  generatePromptSet: (body: GenerateBody) => post<GenerateResult>("/api/prompt-sets/generate", body),
  promptSet: (id: string) => get<PromptSet>(`/api/prompt-sets/${enc(id)}`),
  deployPromptSet: (id: string, body: DeployBody) => post<DeployResult>(`/api/prompt-sets/${enc(id)}/deploy`, body),
  addPromptItems: (id: string, items: PromptInput[]) => post<PromptSet>(`/api/prompt-sets/${enc(id)}/items`, { items }),
  setApproval: (id: string, itemIds: string[] | "all", approval: Approval) => post<{ updated: number }>(`/api/prompt-sets/${enc(id)}/approval`, { itemIds, approval }),
  clearNegatives: (id: string) => post<{ cleared: number }>(`/api/prompt-sets/${enc(id)}/clear-negatives`, {}),
  updatePromptItem: (id: string, body: Partial<Pick<PromptItem, "title" | "objective" | "prompt" | "negative" | "durationSec" | "aspectRatio" | "approval">>) =>
    patch<PromptItem>(`/api/prompt-items/${enc(id)}`, body),
  deletePromptItem: (id: string) => del<{ ok: boolean }>(`/api/prompt-items/${enc(id)}`),
  duplicatePromptItem: (id: string) => post<PromptItem>(`/api/prompt-items/${enc(id)}/duplicate`),
  rewritePromptItem: (id: string, body: { instruction: string; providerConfigId: string; modelId: string }) => post<PromptItem>(`/api/prompt-items/${enc(id)}/rewrite`, body),

  // batch
  estimate: (body: BatchRequest) => post<{ check: BatchCheck; estimate: BatchEstimate }>("/api/batches/estimate", body),
  createBatch: (body: BatchRequest) => post<{ batch: Batch; check: BatchCheck; estimate: BatchEstimate }>("/api/batches", body),
  batches: (sessionId?: string | null) => get<{ batches: Batch[] }>(`/api/batches${qs({ sessionId })}`),
  batch: (id: string) => get<Batch>(`/api/batches/${enc(id)}`),
  approveBatch: (id: string, body: CostConfirm) => post<Batch>(`/api/batches/${enc(id)}/approve`, body),
  setBatchConcurrency: (id: string, maxConcurrency: number) => post<Batch>(`/api/batches/${enc(id)}/concurrency`, { maxConcurrency }),
  pauseBatch: (id: string) => post<Batch>(`/api/batches/${enc(id)}/pause`),
  resumeBatch: (id: string) => post<Batch>(`/api/batches/${enc(id)}/resume`),
  cancelPending: (id: string) => post<{ cancelled: number }>(`/api/batches/${enc(id)}/cancel-pending`),
  retryFailed: (id: string, body: Partial<CostConfirm>) => post<{ retried: string[]; estimate: number | null; skipped: { id: string; reason: string }[] }>(`/api/batches/${enc(id)}/retry-failed`, body),
  batchEvents: (id: string) => get<{ events: JobEventRow[] }>(`/api/batches/${enc(id)}/events`),
  deleteBatch: (id: string, keepAssets = false) => del<{ batchId: string; jobsDeleted: number; assetsDeleted: number; freedBytes: number }>(`/api/batches/${enc(id)}${keepAssets ? "?keepAssets=1" : ""}`),

  // job
  jobs: (q: { batchId?: string; sessionId?: string; status?: string[]; q?: string; limit?: number; offset?: number }) =>
    get<{ total: number; jobs: Job[] }>(`/api/jobs${qs({ batchId: q.batchId, sessionId: q.sessionId, status: q.status?.join(","), q: q.q, limit: q.limit, offset: q.offset })}`),
  job: (id: string) => get<Job>(`/api/jobs/${enc(id)}`),
  jobVersions: (id: string) => get<{ versions: Job[] }>(`/api/jobs/${enc(id)}/versions`),
  jobEvents: (id: string) => get<{ events: JobEventRow[] }>(`/api/jobs/${enc(id)}/events`),
  cancelJob: (id: string) => post<{ job: Job; cancelled: boolean; message: string }>(`/api/jobs/${enc(id)}/cancel`),
  retryJobs: (body: { jobIds: string[] } & Partial<CostConfirm>) => post<{ retried: string[]; estimate: number | null; skipped: { id: string; reason: string }[] }>("/api/jobs/retry", body),
  approveJobs: (body: { jobIds: string[] } & CostConfirm) => post<{ approved: number }>("/api/jobs/approve", body),
  regenerateJob: (id: string, body: { prompt?: string; negative?: string | null; durationSec?: number; aspectRatio?: string } & Partial<CostConfirm>) => post<Job>(`/api/jobs/${enc(id)}/regenerate`, body),

  // thư viện
  library: (libraryOnly: boolean) => get<{ items: LibraryItem[] }>(`/api/library${qs({ libraryOnly })}`),
};

export const exportUrls = {
  batch: (id: string, format: "zip" | "csv" | "json" | "txt") => `/api/batches/${enc(id)}/export?format=${format}`,
  promptSet: (id: string, format: "txt" | "csv" | "json", onlyApproved = false) => `/api/prompt-sets/${enc(id)}/export?format=${format}${onlyApproved ? "&onlyApproved=1" : ""}`,
};

/** Tải file lên (multipart, field "file") có báo tiến độ - dùng XMLHttpRequest */
export function uploadAssets(files: File[], q: { kind: "reference" | "image"; sessionId?: string | null }, onProgress?: (pct: number) => void): Promise<Asset[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/assets${qs({ kind: q.kind, sessionId: q.sessionId })}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-BVS-Request", "1");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onerror = () => reject(new ApiError("NETWORK", "Mất kết nối khi tải lên.", 0));
    xhr.onload = () => {
      type UploadBody = { assets?: Asset[]; error?: { code?: string; message?: string; details?: unknown } } | null;
      let body: UploadBody = null;
      try {
        body = JSON.parse(xhr.responseText) as UploadBody;
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body?.assets) {
        onProgress?.(100);
        resolve(body.assets);
        return;
      }
      const err = new ApiError(body?.error?.code ?? `HTTP_${xhr.status}`, body?.error?.message ?? `Tải lên thất bại (HTTP ${xhr.status}).`, xhr.status, body?.error?.details ?? null);
      if (xhr.status === 401 && err.code === "UNAUTHORIZED") unauthorizedHandler?.();
      reject(err);
    };
    xhr.send(form);
  });
}

/** Lưu Blob thành file trên máy người dùng */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Đọc file người dùng chọn thành văn bản (UTF-8) */
export function readFileText(file: File): Promise<string> {
  return file.text();
}
