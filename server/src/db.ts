import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import path from "node:path";

/**
 * SQLite (node:sqlite, không cần native module). WAL + busy_timeout để server
 * và worker riêng (npm run worker) cùng mở một file an toàn. Mọi lệnh "nhận
 * job" chạy trong BEGIN IMMEDIATE → hai worker không bao giờ nhận trùng job.
 */
export type Row = Record<string, unknown>;

export class Db {
  readonly raw: DatabaseSync;
  readonly file: string;
  private depth = 0;

  constructor(dataDir: string, fileName = "studio.db", maxMigration = Infinity) {
    this.file = fileName === ":memory:" ? ":memory:" : path.join(dataDir, fileName);
    this.raw = new DatabaseSync(this.file);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    migrate(this, maxMigration);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Giao dịch ghi (BEGIN IMMEDIATE). Lồng nhau = chạy trong giao dịch ngoài. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* đã rollback */
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor',
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE auth_sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE settings (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  secret_enc TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- Phiên làm việc (project/session): gom phân tích, bộ prompt, batch, chat, skill
CREATE TABLE studio_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  skill_mode TEXT NOT NULL DEFAULT 'auto',
  skill_ids_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_ws ON studio_sessions(workspace_id, updated_at);

CREATE TABLE video_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  kind TEXT NOT NULL,                 -- reference | generated | image
  origin TEXT NOT NULL,               -- upload | provider
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,         -- tương đối với STORAGE_DIR
  preview_path TEXT,                  -- bản H.264 để phát trên trình duyệt (nếu gốc không phát được)
  thumbnail_path TEXT,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  duration_sec REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  video_codec TEXT,
  has_audio INTEGER,
  source_job_id TEXT,
  source_attempt INTEGER,
  in_library INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assets_ws ON video_assets(workspace_id, created_at);
-- Một lần tạo (job + attempt) chỉ ra MỘT asset: polling/webhook trùng không tạo asset thứ hai
CREATE UNIQUE INDEX uq_assets_job_attempt ON video_assets(source_job_id, source_attempt) WHERE source_job_id IS NOT NULL;

CREATE TABLE video_analyses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  asset_id TEXT NOT NULL REFERENCES video_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL,               -- queued | running | completed | failed
  progress INTEGER NOT NULL DEFAULT 0,
  step TEXT,
  models_json TEXT NOT NULL DEFAULT '{}',
  coverage_json TEXT NOT NULL DEFAULT '{}',
  measurements_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_analyses_asset ON video_analyses(asset_id);

CREATE TABLE prompt_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,               -- ai | import | manual
  params_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE prompt_items (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES prompt_sets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  negative TEXT,
  model TEXT,
  duration_sec INTEGER,
  aspect_ratio TEXT,
  genre TEXT,
  reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  approval TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_prompt_items_set ON prompt_items(set_id, idx);

CREATE TABLE video_provider_configurations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,        -- mock | seedance-byteplus
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT 'none',
  model_ids_json TEXT NOT NULL DEFAULT '[]',
  default_model_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  requests_per_minute INTEGER NOT NULL DEFAULT 30,
  options_json TEXT NOT NULL DEFAULT '{}',   -- giá do người dùng nhập, tùy chọn riêng (không secret)
  secret_enc TEXT,                            -- API key (mã hóa)
  webhook_secret_enc TEXT,
  last_test_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE provider_rate_windows (
  provider_config_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (provider_config_id, window_start)
);

CREATE TABLE video_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,                 -- single | list | file | ai
  prompt_set_id TEXT,
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL,
  status TEXT NOT NULL,               -- draft | awaiting_approval | running | paused | completed | cancelled
  budget_limit REAL,
  estimate_json TEXT,
  estimated_cost REAL,
  actual_cost REAL,
  currency TEXT,
  approved_by TEXT,
  approved_at TEXT,
  approved_max_cost REAL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_batches_ws ON video_batches(workspace_id, created_at);

CREATE TABLE video_batch_jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES video_batches(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  session_id TEXT,
  seq INTEGER NOT NULL,
  prompt_item_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL,
  negative TEXT,
  reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  provider_config_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,       -- lần gửi provider hiện tại (tăng khi gửi lại)
  max_attempts INTEGER NOT NULL DEFAULT 3,
  manual_retries INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  resubmit_same_key INTEGER NOT NULL DEFAULT 0, -- lần gửi trước không rõ kết quả + provider có idempotency → gửi lại ĐÚNG key cũ
  transient_failures INTEGER NOT NULL DEFAULT 0,
  remote_job_id TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  poll_failures INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  progress INTEGER,
  error_code TEXT,
  error_message TEXT,
  error_detail TEXT,
  output_asset_id TEXT,
  estimated_cost REAL,
  actual_cost REAL,
  lineage_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  completed_at TEXT
);
CREATE INDEX idx_jobs_batch ON video_batch_jobs(batch_id, seq);
CREATE INDEX idx_jobs_status ON video_batch_jobs(status, next_attempt_at);
CREATE INDEX idx_jobs_remote ON video_batch_jobs(provider_config_id, remote_job_id);
CREATE UNIQUE INDEX uq_jobs_idem ON video_batch_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE generation_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  asset_id TEXT,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (lineage_id, version)
);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  batch_id TEXT,
  job_id TEXT,
  type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  message TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_job_events_job ON job_events(job_id, id);
CREATE INDEX idx_job_events_batch ON job_events(batch_id, id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  user_id TEXT,
  actor TEXT NOT NULL,                -- ui | api-token | mcp | chat | system
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_ws ON audit_log(workspace_id, id);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- user | assistant | tool
  content TEXT NOT NULL DEFAULT '',
  tool_calls_json TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_session ON chat_messages(session_id, created_at);

-- Trạng thái "phía provider" của Mock provider: phải sống qua restart để kiểm khôi phục hàng đợi
CREATE TABLE mock_remote_tasks (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  provider_config_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  started_ms INTEGER,
  finish_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,              -- success | fail | fail-transient
  result_path TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX uq_mock_idem ON mock_remote_tasks(provider_config_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
  {
    version: 2,
    sql: `
-- Hàng đợi tự đăng Reels lên Facebook Page
CREATE TABLE fb_reel_posts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  asset_id TEXT NOT NULL UNIQUE REFERENCES video_assets(id) ON DELETE CASCADE,
  job_id TEXT,
  status TEXT NOT NULL,               -- pending_review | approved | publishing | published | failed | skipped | rejected
  caption TEXT,
  skip_reason TEXT,
  error_message TEXT,                 -- đã che token
  fb_video_id TEXT,
  fb_post_id TEXT,
  step TEXT,                          -- started | uploaded | finishing | finished
  attempts INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT,
  approved_at TEXT,
  publishing_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_fbr_status ON fb_reel_posts(workspace_id, status, created_at);
`,
  },
  {
    version: 3,
    sql: `
-- Facebook nhiều Page: mỗi dòng = một Page. Token giữ NGUYÊN bản mã hoá (ctx.secrets), không giải mã khi migrate.
CREATE TABLE fb_pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_custom INTEGER NOT NULL DEFAULT 0,
  page_id TEXT NOT NULL,
  token_enc TEXT,
  token_last4 TEXT,
  auto_enabled INTEGER NOT NULL DEFAULT 0,
  interval_min INTEGER NOT NULL DEFAULT 60,
  require_approval INTEGER NOT NULL DEFAULT 1,
  hashtags TEXT NOT NULL DEFAULT '',
  enabled_since TEXT,
  last_publish_at INTEGER NOT NULL DEFAULT 0,
  pause_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX uq_fb_pages_active ON fb_pages(workspace_id, page_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_fb_pages_ws ON fb_pages(workspace_id, deleted_at);
ALTER TABLE fb_reel_posts ADD COLUMN fb_page_id TEXT;
ALTER TABLE video_batches ADD COLUMN fb_page_id TEXT;
CREATE INDEX idx_fbr_page ON fb_reel_posts(fb_page_id, status, created_at);

-- Cấu hình một-Page cũ → Page đầu tiên (id cố định nên chạy lại cũng không nhân đôi)
INSERT OR IGNORE INTO fb_pages (id, workspace_id, name, name_custom, page_id, token_enc, token_last4, auto_enabled, interval_min, require_approval, hashtags, enabled_since, last_publish_at, pause_json, created_at, updated_at)
SELECT 'fbp_legacy_' || s.workspace_id, s.workspace_id, 'Page chính', 0,
       json_extract(s.value_json, '$.pageId'), s.secret_enc, json_extract(s.value_json, '$.tokenLast4'),
       CASE WHEN json_extract(s.value_json, '$.autoEnabled') IN (1, 'true') THEN 1 ELSE 0 END,
       COALESCE(json_extract(s.value_json, '$.intervalMin'), 60),
       CASE WHEN json_extract(s.value_json, '$.requireApproval') IN (0, 'false') THEN 0 ELSE 1 END,
       COALESCE(json_extract(s.value_json, '$.hashtags'), ''),
       json_extract(s.value_json, '$.enabledSince'),
       COALESCE((SELECT json_extract(st.value_json, '$.lastPublishAt') FROM settings st WHERE st.workspace_id = s.workspace_id AND st.key = 'facebook_reels_state'), 0),
       (SELECT json_extract(st.value_json, '$.pause') FROM settings st WHERE st.workspace_id = s.workspace_id AND st.key = 'facebook_reels_state'),
       s.updated_at, s.updated_at
FROM settings s
WHERE s.key = 'facebook_reels' AND s.secret_enc IS NOT NULL
  AND COALESCE(json_extract(s.value_json, '$.pageId'), '') <> '';

UPDATE fb_reel_posts SET fb_page_id = 'fbp_legacy_' || workspace_id
 WHERE fb_page_id IS NULL AND EXISTS (SELECT 1 FROM fb_pages p WHERE p.id = 'fbp_legacy_' || fb_reel_posts.workspace_id);
-- Batch cũ của workspace đang bật tự đăng vẫn được đăng (giữ hành vi cũ)
UPDATE video_batches SET fb_page_id = 'fbp_legacy_' || workspace_id
 WHERE fb_page_id IS NULL AND EXISTS (SELECT 1 FROM fb_pages p WHERE p.id = 'fbp_legacy_' || video_batches.workspace_id AND p.auto_enabled = 1);
`,
  },
  {
    version: 4,
    sql: `
-- Gắn link Shopee: link của batch được SAO CHÉP sang từng bài lúc xếp hàng; bình luận có trạng thái riêng
ALTER TABLE video_batches ADD COLUMN shopee_url TEXT;
ALTER TABLE fb_reel_posts ADD COLUMN shopee_url TEXT;
ALTER TABLE fb_reel_posts ADD COLUMN comment_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE fb_reel_posts ADD COLUMN comment_error TEXT;
ALTER TABLE fb_reel_posts ADD COLUMN fb_comment_id TEXT;
ALTER TABLE fb_reel_posts ADD COLUMN comment_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fb_reel_posts ADD COLUMN next_comment_at TEXT;
CREATE INDEX idx_fbr_comment ON fb_reel_posts(comment_status, next_comment_at);
`,
  },
];

export function migrate(db: Db, maxVersion = Infinity): void {
  db.raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (done.has(m.version) || m.version > maxVersion) continue;
    db.tx(() => {
      // Hai tiến trình cùng khởi động: kiểm tra lại trong giao dịch (ALTER ADD COLUMN không idempotent)
      if (db.get("SELECT 1 FROM schema_migrations WHERE version = ?", m.version)) return;
      db.raw.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", m.version, new Date().toISOString());
    });
  }
}
