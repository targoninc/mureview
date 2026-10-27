import { createHash, randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { McpKey, RepoStatus, ReviewSet } from '../shared/types';
import { config } from './config';
import { requireUser } from './auth/session';
import { type UserRow, db } from './db';
import { HttpError, json } from './http';
import { buildDetail, readableReviewSets } from './reviewSets';
import type { Ctx } from './router';

const keyPrefix = 'mrv_';
const mcpUrl = () => `${config.baseUrl}/api/mcp`;

interface McpKeyRow {
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

function jsonText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function messageOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return 'mureview could not complete the request.';
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

function mcpUser(row: McpKeyRow): UserRow | null {
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

function markInitialized(key: McpKeyRow, clientName: unknown): void {
  const name =
    typeof clientName === 'string' && clientName.trim() ? clientName.trim().slice(0, 100) : null;
  if (!name) return;
  db.run('UPDATE mcp_keys SET client_name = ? WHERE id = ?', [name, key.id]);
}

function markUsed(key: McpKeyRow): void {
  db.run(
    "UPDATE mcp_keys SET used_at = COALESCE(used_at, datetime('now')), last_used_at = datetime('now') WHERE id = ?",
    [key.id],
  );
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'invalid_token' }), {
    status: 401,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Bearer realm="mureview"',
      'Cache-Control': 'no-store',
    },
  });
}

function summary(set: ReviewSet) {
  return {
    id: set.id,
    name: set.name,
    mode: set.mode,
    targetBranch: set.targetBranch,
    repoCount: set.repos.length,
    owner: set.owner?.name ?? null,
  };
}

function repoSummary(repo: RepoStatus) {
  return {
    connectionId: repo.connectionId,
    host: repo.host,
    repo: repo.repo,
    branch: repo.branch,
    target: repo.target,
    position: repo.position,
    state: repo.state,
    aheadBy: repo.aheadBy ?? null,
    behindBy: repo.behindBy ?? null,
    additions: repo.additions ?? 0,
    deletions: repo.deletions ?? 0,
    fileCount: repo.files?.length ?? 0,
    commitCount: repo.commits?.length ?? 0,
    pullRequest: repo.pullRequest ?? null,
    error: repo.error ?? null,
    note: repo.note ?? null,
  };
}

function buildServer(user: UserRow): McpServer {
  const server = new McpServer({ name: 'mureview', version: '1.0.0' });

  server.registerTool(
    'list_review_sets',
    {
      title: 'List review sets',
      description:
        'List the mureview review sets this account can read, with their target branch and repository count. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { reviewSets, sharedReviewSets } = await readableReviewSets(user);
      return jsonText({
        owned: reviewSets.map(summary),
        shared: sharedReviewSets.map(summary),
      });
    },
  );

  server.registerTool(
    'get_review_set',
    {
      title: 'Get a review set',
      description:
        'Read one review set: per-repository branches, diff stats, pull requests and errors. Read-only.',
      inputSchema: {
        reviewSetId: z.number().int().positive().describe('The review set id from list_review_sets.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ reviewSetId }) => {
      try {
        const detail = await buildDetail(user, reviewSetId);
        return jsonText({
          reviewSet: summary(detail.reviewSet),
          state: detail.pr.state,
          prId: detail.pr.prId,
          stats: detail.pr.stats,
          errors: detail.pr.errors,
          repos: detail.pr.repos.map(repoSummary),
          combined: detail.pr.combined?.map(repoSummary) ?? null,
        });
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    'list_review_set_files',
    {
      title: 'List changed files',
      description:
        'List the changed files in a review set, with status and line stats. Use get_file_diff for a patch. Read-only.',
      inputSchema: {
        reviewSetId: z.number().int().positive().describe('The review set id.'),
        offset: z.number().int().min(0).optional().describe('How many files to skip. Defaults to 0.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many files to return. Defaults to 100.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ reviewSetId, offset, limit }) => {
      try {
        const detail = await buildDetail(user, reviewSetId);
        const files = detail.pr.repos.flatMap((repo) =>
          (repo.files ?? []).map((file) => ({
            connectionId: repo.connectionId,
            host: repo.host,
            repo: repo.repo,
            position: repo.position,
            path: file.path,
            prevPath: file.prevPath ?? null,
            type: file.type,
            additions: file.additions,
            deletions: file.deletions,
            hasPatch: Boolean(file.patch),
          })),
        );
        const start = offset ?? 0;
        const size = limit ?? 100;
        return jsonText({
          total: files.length,
          offset: start,
          limit: size,
          files: files.slice(start, start + size),
          truncated: start + size < files.length,
        });
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    'get_file_diff',
    {
      title: 'Read a file diff',
      description:
        'Read the unified patch for one changed file in a review set. Pass position when a stacked review has the same path in several layers. Read-only.',
      inputSchema: {
        reviewSetId: z.number().int().positive().describe('The review set id.'),
        path: z.string().min(1).describe('The file path as returned by list_review_set_files.'),
        connectionId: z.number().int().positive().optional().describe('Only match this connection.'),
        repo: z.string().optional().describe('Only match this repository, such as owner/name.'),
        position: z.number().int().min(0).optional().describe('Only match this stack layer.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ reviewSetId, path, connectionId, repo, position }) => {
      try {
        const detail = await buildDetail(user, reviewSetId);
        const matches = detail.pr.repos.flatMap((entry) => {
          if (connectionId !== undefined && entry.connectionId !== connectionId) return [];
          if (repo !== undefined && entry.repo !== repo) return [];
          if (position !== undefined && entry.position !== position) return [];
          return (entry.files ?? []).filter((file) => file.path === path).map((file) => ({ entry, file }));
        });
        if (matches.length === 0) return toolError(`No file ${path} in review set ${reviewSetId}.`);
        if (matches.length > 1 && position === undefined) {
          return jsonText({
            matches: matches.map(({ entry }) => ({
              connectionId: entry.connectionId,
              repo: entry.repo,
              position: entry.position,
            })),
            note: 'The path exists in more than one layer. Pass position to choose one.',
          });
        }
        const { entry, file } = matches[0];
        const patch = file.patch ?? null;
        const maxChars = 200_000;
        const truncated = patch !== null && patch.length > maxChars;
        return jsonText({
          connectionId: entry.connectionId,
          repo: entry.repo,
          position: entry.position,
          path: file.path,
          prevPath: file.prevPath ?? null,
          type: file.type,
          additions: file.additions,
          deletions: file.deletions,
          patch: truncated ? patch.slice(0, maxChars) : patch,
          truncated,
        });
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  server.registerTool(
    'list_review_set_comments',
    {
      title: 'List review comments',
      description:
        'List the comments on a review set pull request, including inline threads and resolved state. Read-only.',
      inputSchema: {
        reviewSetId: z.number().int().positive().describe('The review set id.'),
        includeResolved: z.boolean().optional().describe('Include resolved threads. Defaults to false.'),
        limit: z.number().int().min(1).max(500).optional().describe('How many comments to return. Defaults to 200.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ reviewSetId, includeResolved, limit }) => {
      try {
        const detail = await buildDetail(user, reviewSetId);
        const all = includeResolved ? detail.pr.comments : detail.pr.comments.filter((comment) => !comment.resolved);
        const size = limit ?? 200;
        return jsonText({
          prId: detail.pr.prId,
          total: all.length,
          comments: all.slice(0, size).map((comment) => ({
            id: comment.id,
            author: comment.author.name,
            body: comment.body,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            resolved: comment.resolved,
            source: comment.source,
            createdAt: comment.createdAt,
          })),
          truncated: all.length > size,
        });
      } catch (error) {
        return toolError(messageOf(error));
      }
    },
  );

  return server;
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
  return json(
    { prompt: buildMcpPrompt(key.token), prefix: key.prefix },
    201,
    { 'Cache-Control': 'no-store' },
  );
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

function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return match?.[1]?.trim() || null;
}

export function mcpMethodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    }),
    { status: 405, headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' } },
  );
}

export async function mcpEndpoint(ctx: Ctx): Promise<Response> {
  if (ctx.req.method !== 'POST') return mcpMethodNotAllowed();

  const origin = ctx.req.headers.get('origin');
  if (origin && origin !== new URL(config.baseUrl).origin) {
    return new Response(null, { status: 403 });
  }

  const token = bearerToken(ctx.req.headers.get('authorization'));
  if (!token) return unauthorized();
  const key = lookupMcpKey(token);
  if (!key) return unauthorized();
  const user = mcpUser(key);
  if (!user) return unauthorized();

  let parsedBody: unknown;
  try {
    parsedBody = await ctx.req.clone().json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  const methods = messages.map((message) =>
    message && typeof message === 'object' && 'method' in message ? String((message as { method: unknown }).method) : '',
  );
  const initialize = messages.find((message) => {
    return Boolean(
      message &&
        typeof message === 'object' &&
        (message as { method?: string }).method === 'initialize',
    );
  }) as { params?: { clientInfo?: { name?: string } } } | undefined;
  const usesTools = methods.some((method) => method === 'tools/list' || method === 'tools/call');

  const server = buildServer(user);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(ctx.req, {
    parsedBody,
    authInfo: { token, clientId: String(key.id), scopes: ['read'] },
  });

  if (response.ok) {
    if (initialize) markInitialized(key, initialize.params?.clientInfo?.name);
    if (usesTools) markUsed(key);
  }
  return response;
}
