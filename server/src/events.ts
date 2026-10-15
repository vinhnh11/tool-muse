import { EventEmitter } from "node:events";
import type { Db } from "./db.ts";
import { nowIso } from "./util.ts";

/**
 * Luồng sự kiện BỀN: mọi thay đổi trạng thái job/batch/phân tích ghi vào bảng
 * job_events. SSE đọc đuôi bảng theo id → web thấy cả thay đổi do worker ở
 * tiến trình khác gây ra, F5 không mất gì. EventEmitter chỉ để đánh thức SSE sớm.
 */
export const wake = new EventEmitter();
wake.setMaxListeners(1000);

export interface EventInput {
  workspaceId: string;
  type: string;
  batchId?: string | null;
  jobId?: string | null;
  from?: string | null;
  to?: string | null;
  message?: string | null;
  data?: unknown;
}

export function recordEvent(db: Db, e: EventInput): void {
  db.run(
    `INSERT INTO job_events (workspace_id, batch_id, job_id, type, from_status, to_status, message, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.workspaceId,
    e.batchId ?? null,
    e.jobId ?? null,
    e.type,
    e.from ?? null,
    e.to ?? null,
    e.message ?? null,
    e.data === undefined ? null : JSON.stringify(e.data),
    nowIso(),
  );
  wake.emit("event", e.workspaceId);
}

export interface AuditInput {
  workspaceId?: string | null;
  userId?: string | null;
  actor: string;
  action: string;
  targetType?: string;
  targetId?: string;
  data?: unknown;
}

/** Nhật ký hành động quan trọng - KHÔNG bao giờ ghi secret vào data */
export function audit(db: Db, a: AuditInput): void {
  db.run(
    `INSERT INTO audit_log (workspace_id, user_id, actor, action, target_type, target_id, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    a.workspaceId ?? null,
    a.userId ?? null,
    a.actor,
    a.action,
    a.targetType ?? null,
    a.targetId ?? null,
    a.data === undefined ? null : JSON.stringify(a.data),
    nowIso(),
  );
}
