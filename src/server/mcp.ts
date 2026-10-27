import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import type { RepoStatus, ReviewSet } from '../shared/types';
import { config } from './config';
import type { UserRow } from './db';
import { HttpError, readText } from './http';
import { buildDetail, readableReviewSets } from './reviewSets';
import { lookupMcpKey, markInitialized, markUsed, mcpUser } from './mcpKeys';
import type { Ctx } from './router';

function jsonText(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function readResult<T>(run: () => Promise<T>) {
  return run().then(jsonText).catch((error) => toolError(messageOf(error)));
}

function messageOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return 'mureview could not complete the request.';
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
    async () =>
      readResult(async () => {
        const { reviewSets, sharedReviewSets } = await readableReviewSets(user);
        return {
          owned: reviewSets.map(summary),
          shared: sharedReviewSets.map(summary),
        };
      }),
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
    async ({ reviewSetId }) =>
      readResult(async () => {
        const detail = await buildDetail(user, reviewSetId);
        return {
          reviewSet: summary(detail.reviewSet),
          state: detail.pr.state,
          prId: detail.pr.prId,
          stats: detail.pr.stats,
          errors: detail.pr.errors,
          repos: detail.pr.repos.map(repoSummary),
          combined: detail.pr.combined?.map(repoSummary) ?? null,
        };
      }),
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
    async ({ reviewSetId, offset, limit }) =>
      readResult(async () => {
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
        return {
          total: files.length,
          offset: start,
          limit: size,
          files: files.slice(start, start + size),
          truncated: start + size < files.length,
        };
      }),
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
    async ({ reviewSetId, path, connectionId, repo, position }) =>
      readResult(async () => {
        const detail = await buildDetail(user, reviewSetId);
        const matches = detail.pr.repos.flatMap((entry) => {
          if (connectionId !== undefined && entry.connectionId !== connectionId) return [];
          if (repo !== undefined && entry.repo !== repo) return [];
          if (position !== undefined && entry.position !== position) return [];
          return (entry.files ?? []).filter((file) => file.path === path).map((file) => ({ entry, file }));
        });
        if (matches.length === 0) throw new HttpError(404, `No file ${path} in review set ${reviewSetId}.`);
        if (matches.length > 1 && position === undefined) {
          return {
            matches: matches.map(({ entry }) => ({
              connectionId: entry.connectionId,
              repo: entry.repo,
              position: entry.position,
            })),
            note: 'The path exists in more than one layer. Pass position to choose one.',
          };
        }
        const { entry, file } = matches[0];
        const patch = file.patch ?? null;
        const maxChars = 200_000;
        const truncated = patch !== null && patch.length > maxChars;
        return {
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
        };
      }),
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
    async ({ reviewSetId, includeResolved, limit }) =>
      readResult(async () => {
        const detail = await buildDetail(user, reviewSetId);
        const all = includeResolved ? detail.pr.comments : detail.pr.comments.filter((comment) => !comment.resolved);
        const size = limit ?? 200;
        return {
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
        };
      }),
  );

  return server;
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
    parsedBody = JSON.parse(await readText(ctx.req, 4_000_000));
  } catch (error) {
    if (error instanceof HttpError) throw error;
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
