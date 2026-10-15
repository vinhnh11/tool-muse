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

/** Một dòng job_events như lưu trong DB */
export interface EventRow {
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

/** Định dạng công khai DUY NHẤT cho sự kiện - dùng chung cho SSE và REST lịch sử */
export function eventToPublic(r: EventRow) {
  let data: unknown = null;
  if (r.data_json) {
    try {
      data = JSON.parse(r.data_json);
    } catch {
      data = null;
    }
  }
  return { id: r.id, type: r.type, batchId: r.batch_id, jobId: r.job_id, from: r.from_status, to: r.to_status, message: r.message, data, at: r.created_at };
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
