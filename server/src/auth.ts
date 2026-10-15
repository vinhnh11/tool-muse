import type { Db } from "./db.ts";
import { hashPassword, verifyPassword } from "./secrets.ts";
import { AppError, newId, nowIso, randomToken, sha256Hex } from "./util.ts";

export interface User {
  id: string;
  username: string;
  role: string;
}

export interface Principal {
  user: User;
  /** Kênh gọi: ui (cookie) | api-token (CLI/MCP/Hermes) */
  via: "ui" | "api-token";
}

const SESSION_DAYS = 14;

export function createUser(db: Db, username: string, password: string, role = "member"): { user: User; workspaceId: string } {
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(name)) throw new AppError("INVALID_USERNAME", "Tên đăng nhập 3-32 ký tự: chữ thường, số, . _ -", 400);
  if (password.length < 8) throw new AppError("WEAK_PASSWORD", "Mật khẩu tối thiểu 8 ký tự.", 400);
  if (db.get("SELECT id FROM users WHERE username = ?", name)) throw new AppError("USER_EXISTS", "Tên đăng nhập đã tồn tại.", 409);
  const id = newId("usr");
  const wsId = newId("ws");
  const now = nowIso();
  db.tx(() => {
    db.run("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)", id, name, hashPassword(password), role, now);
    db.run("INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", wsId, `Workspace của ${name}`, id, now);
    db.run("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')", wsId, id);
  });
  return { user: { id, username: name, role }, workspaceId: wsId };
}

export function countUsers(db: Db): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")?.n ?? 0);
}

export function login(db: Db, username: string, password: string): { token: string; user: User; expiresAt: string } {
  const row = db.get<{ id: string; username: string; role: string; password_hash: string }>(
    "SELECT id, username, role, password_hash FROM users WHERE username = ?",
    username.trim().toLowerCase(),
  );
  if (!row || !verifyPassword(password, row.password_hash)) throw new AppError("INVALID_LOGIN", "Sai tên đăng nhập hoặc mật khẩu.", 401);
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.run("INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", sha256Hex(token), row.id, nowIso(), expiresAt);
  return { token, user: { id: row.id, username: row.username, role: row.role }, expiresAt };
}

export function logout(db: Db, sessionToken: string): void {
  db.run("DELETE FROM auth_sessions WHERE id_hash = ?", sha256Hex(sessionToken));
}

export function userFromSession(db: Db, sessionToken: string): User | null {
  const row = db.get<{ id: string; username: string; role: string; expires_at: string }>(
    `SELECT u.id, u.username, u.role, s.expires_at FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    sha256Hex(sessionToken),
  );
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    db.run("DELETE FROM auth_sessions WHERE id_hash = ?", sha256Hex(sessionToken));
    return null;
  }
  return { id: row.id, username: row.username, role: row.role };
}

/** Token API cho CLI / MCP / Hermes. Chỉ trả nguyên văn MỘT lần lúc tạo, DB giữ hash. */
export function createApiToken(db: Db, userId: string, name: string): { id: string; token: string } {
  const id = newId("tok");
  const token = `bvs_${randomToken(32)}`;
  db.run("INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, userId, name, sha256Hex(token), nowIso());
  return { id, token };
}

export function userFromApiToken(db: Db, token: string): User | null {
  const row = db.get<{ id: string; username: string; role: string; tok_id: string }>(
    `SELECT u.id, u.username, u.role, t.id AS tok_id FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
    sha256Hex(token),
  );
  if (!row) return null;
  db.run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", nowIso(), row.tok_id);
  return { id: row.id, username: row.username, role: row.role };
}

export function listApiTokens(db: Db, userId: string): { id: string; name: string; created_at: string; last_used_at: string | null }[] {
  return db.all("SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC", userId);
}

export function revokeApiToken(db: Db, userId: string, tokenId: string): boolean {
  return db.run("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", tokenId, userId).changes > 0;
}

export function workspacesOf(db: Db, userId: string): { id: string; name: string; role: string }[] {
  return db.all(
    `SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at`,
    userId,
  );
}

/** Kiểm quyền: người dùng phải là thành viên workspace. Sai quyền = 404 (không lộ là tồn tại). */
export function assertWorkspaceAccess(db: Db, userId: string, workspaceId: string): void {
  const ok = db.get("SELECT 1 AS ok FROM workspace_members WHERE workspace_id = ? AND user_id = ?", workspaceId, userId);
  if (!ok) throw new AppError("NOT_FOUND", "Không tìm thấy workspace.", 404);
}

export function resolveWorkspace(db: Db, userId: string, requested?: string | null): string {
  if (requested) {
    assertWorkspaceAccess(db, userId, requested);
    return requested;
  }
  const first = workspacesOf(db, userId)[0];
  if (!first) throw new AppError("NO_WORKSPACE", "Tài khoản chưa thuộc workspace nào.", 403);
  return first.id;
}
