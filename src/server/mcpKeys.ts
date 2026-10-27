import { createHash, randomBytes } from 'node:crypto';
import type { McpKey } from '../shared/types';
import { requireUser } from './auth/session';
import { config } from './config';
import { type UserRow, db } from './db';
import { HttpError, json } from './http';
import type { Ctx } from './router';

const keyPrefix = 'mrv_';
const mcpUrl = () => `${config.baseUrl}/api/mcp`;

export interface McpKeyRow {
  id: number;
  user_id: number;
  client_name: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return `${keyPrefix}${randomBytes(32).toString('base64url')}`;
}

export function createMcpKey(userId: number): { id: number; prefix: string; token: string } {
  const token = newToken();
  const prefix = token.slice(0, keyPrefix.length + 6);
  const inserted = db.run('INSERT INTO mcp_keys (user_id, key_hash, key_prefix) VALUES (?, ?, ?)', [
    userId,
    hashToken(token),
    prefix,
  ]);
  return { id: Number(inserted.lastInsertRowid), prefix, token };
}

export function lookupMcpKey(token: string): McpKeyRow | null {
  return (
    db
      .query<McpKeyRow, [string]>('SELECT id, user_id, client_name FROM mcp_keys WHERE key_hash = ?')
      .get(hashToken(token)) ?? null
  );
}

export function mcpUser(row: McpKeyRow): UserRow | null {
  return db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(row.user_id) ?? null;
}

export function listMcpKeys(userId: number): McpKey[] {
  return db
    .query<McpKey, [number]>(
      `SELECT id, key_prefix AS prefix, client_name AS clientName, created_at AS createdAt,
              used_at AS usedAt, last_used_at AS lastUsedAt
       FROM mcp_keys
       WHERE user_id = ? AND used_at IS NOT NULL
       ORDER BY last_used_at DESC, id DESC`,
    )
    .all(userId);
}

export function deleteMcpKey(userId: number, id: number): boolean {
  return db.run('DELETE FROM mcp_keys WHERE id = ? AND user_id = ?', [id, userId]).changes > 0;
}

export function markInitialized(key: McpKeyRow, clientName: unknown): void {
  const name =
    typeof clientName === 'string' && clientName.trim() ? clientName.trim().slice(0, 100) : null;
  if (!name) return;
  db.run('UPDATE mcp_keys SET client_name = ? WHERE id = ?', [name, key.id]);
}

export function markUsed(key: McpKeyRow): void {
  db.run(
    "UPDATE mcp_keys SET used_at = COALESCE(used_at, datetime('now')), last_used_at = datetime('now') WHERE id = ?",
    [key.id],
  );
}

export function buildMcpPrompt(token: string): string {
  const url = mcpUrl();
  return `Connect to mureview over MCP.

Add this MCP server to the client you are running in:
- Name: mureview
- Transport: streamable HTTP (POST)
- URL: ${url}
- Header: Authorization: Bearer ${token}

Use the setup method that fits this client. For example:
- Claude Code: claude mcp add --transport http mureview ${url} --header "Authorization: Bearer ${token}"
- Codex: add an [mcp_servers.mureview] entry to ~/.codex/config.toml with this URL and an Authorization HTTP header.
- Cursor or VS Code: add an "mureview" server with type "http", this URL, and the Authorization header.

Keep the URL and header exactly as written. After connecting, call tools/list and tell me which mureview tools are available. Do not copy the key anywhere else.`;
}

export async function createMcpKeyRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const key = createMcpKey(user.id);
  return json({ prompt: buildMcpPrompt(key.token), prefix: key.prefix }, 201, { 'Cache-Control': 'no-store' });
}

export function listMcpKeysRoute(ctx: Ctx): Response {
  const user = requireUser(ctx);
  return json({ keys: listMcpKeys(user.id) });
}

export function deleteMcpKeyRoute(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Key not found');
  if (!deleteMcpKey(user.id, id)) throw new HttpError(404, 'Key not found');
  return new Response(null, { status: 204 });
}
