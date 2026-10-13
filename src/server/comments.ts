import type { Comment, CommentInput } from '../shared/types';
import { connectionById, connectionsFor } from './auth/identities';
import { publicUser, requireUser } from './auth/session';
import { db } from './db';
import { clientFor } from './forges';
import { hostOf } from './forges/types';
import { HttpError, json, readJson } from './http';
import { markCommentSynced, repoPullRequest } from './pullRequests';
import type { Ctx } from './router';

interface CommentRow {
  id: number;
  pr_id: number;
  connection_id: number | null;
  author_name: string;
  author_avatar: string;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  body: string;
  synced_at: string | null;
  forge_comment_id: string | null;
  source: string;
  created_at: string;
}

interface PrRow {
  id: number;
  review_set_id: number;
  closed_at: string | null;
  owner_id: number;
}

const SELECT_COMMENT = `SELECT c.* FROM comments c`;

const connectionHosts = new Map<number, string>();

/**
 * Avatars hosted on the forge itself (Azure DevOps and some Forgejo setups)
 * need the connection credentials, so they are served through our own
 * /api/forge-avatar endpoint. Public avatars on other hosts are left alone.
 */
function proxiedAvatar(connectionId: number | null, avatarUrl: string): string {
  if (!connectionId || !avatarUrl) return avatarUrl;
  let host = connectionHosts.get(connectionId);
  if (host === undefined) {
    const row = db.query<{ base_url: string }, [number]>('SELECT base_url FROM forge_connections WHERE id = ?').get(connectionId);
    host = row ? hostOf(row.base_url) : '';
    connectionHosts.set(connectionId, host);
  }
  if (!host) return avatarUrl;
  try {
    if (new URL(avatarUrl).host !== host) return avatarUrl;
  } catch {
    return avatarUrl;
  }
  return `/api/forge-avatar?connectionId=${connectionId}&url=${encodeURIComponent(avatarUrl)}`;
}

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    prId: row.pr_id,
    author: {
      name: row.author_name,
      avatarUrl: row.source === 'forge' ? proxiedAvatar(row.connection_id, row.author_avatar) : row.author_avatar,
    },
    connectionId: row.connection_id,
    repo: row.repo,
    path: row.path,
    line: row.line,
    side: row.side === 'additions' || row.side === 'deletions' ? row.side : null,
    body: row.body,
    synced: row.synced_at !== null,
    source: row.source === 'forge' ? 'forge' : 'mureview',
    forgeCommentId: row.forge_comment_id,
    createdAt: row.created_at,
  };
}

export function listUnsyncedComments(prId: number): Comment[] {
  const rows = db
    .query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.pr_id = ? AND c.path IS NOT NULL AND c.synced_at IS NULL ORDER BY c.id`)
    .all(prId);
  return rows.map(toComment);
}

export function listComments(prId: number): Comment[] {
  const rows = db
    .query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.pr_id = ? ORDER BY c.created_at, c.id`)
    .all(prId);
  return rows.map(toComment);
}

export function loadOwnedPr(userId: number, id: number): PrRow {
  const pr = db
    .query<PrRow, [number]>(
      `SELECT p.id, p.review_set_id, p.closed_at, r.owner_id FROM pull_requests p JOIN review_sets r ON r.id = p.review_set_id WHERE p.id = ?`,
    )
    .get(id);
  if (!pr || pr.owner_id !== userId) throw new HttpError(404, 'Pull request not found');
  return pr;
}

function normalizeAnchor(userId: number, input: CommentInput) {
  if (!input.path) return { connectionId: null, repo: null, path: null, line: null, side: null };
  const connectionId = Number(input.connectionId);
  if (!Number.isInteger(connectionId) || !connectionsFor(userId).some((connection) => connection.id === connectionId)) {
    throw new HttpError(400, 'A valid connection is required for line comments.');
  }
  if (typeof input.repo !== 'string' || !input.repo) throw new HttpError(400, 'A repository is required for line comments.');
  if (!Number.isInteger(input.line) || (input.line as number) < 1) throw new HttpError(400, 'A line number is required for line comments.');
  if (input.side !== 'additions' && input.side !== 'deletions') throw new HttpError(400, 'A valid diff side is required for line comments.');
  return { connectionId, repo: input.repo, path: input.path, line: input.line, side: input.side };
}

export function listCommentsRoute(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user.id, Number(ctx.params.id));
  return json({ comments: listComments(pr.id) });
}

export async function createCommentRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user.id, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Comments are only kept while it is open.');

  const input = await readJson<CommentInput>(ctx.req);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new HttpError(400, 'Write something before commenting.');
  if (body.length > 10_000) throw new HttpError(400, 'Comments are limited to 10000 characters.');

  const anchor = normalizeAnchor(user.id, input);
  const inserted = db.run(
    'INSERT INTO comments (pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pr.id, user.id, publicUser(user).name, user.avatar_url, anchor.connectionId, anchor.repo, anchor.path, anchor.line, anchor.side, body, 'mureview'],
  );
  const commentId = Number(inserted.lastInsertRowid);
  const row = db.query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.id = ?`).get(commentId)!;
  await syncCommentToPullRequest(user.id, pr.id, row);
  const synced = db.query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.id = ?`).get(commentId)!;
  return json({ comment: toComment(synced) }, 201);
}

/**
 * Line comments are mirrored onto the repository's forge pull request right
 * away; general comments stay in mureview.
 */
async function syncCommentToPullRequest(userId: number, prId: number, row: CommentRow): Promise<void> {
  if (!row.path || row.connection_id === null || !row.repo || row.line === null || !row.side) return;
  const pull = repoPullRequest(prId, row.connection_id, row.repo);
  if (!pull) return;
  const connection = connectionById(userId, row.connection_id);
  if (!connection) return;
  try {
    const posted = await clientFor(connection).postReviewComment(row.repo, pull.forge_pr_number, {
      body: row.body,
      path: row.path,
      line: row.line,
      side: row.side as 'additions' | 'deletions',
      commitId: pull.head_sha || undefined,
    });
    markCommentSynced(row.id, posted.id);
  } catch (error) {
    console.error(`Could not sync comment ${row.id} to the forge:`, error);
  }
}

export function deleteCommentRoute(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const comment = db
    .query<{ id: number; author_id: number; owner_id: number }, [number]>(
      `SELECT c.id, c.author_id, r.owner_id FROM comments c JOIN pull_requests p ON p.id = c.pr_id JOIN review_sets r ON r.id = p.review_set_id WHERE c.id = ?`,
    )
    .get(Number(ctx.params.id));
  if (!comment || (comment.author_id !== user.id && comment.owner_id !== user.id)) {
    throw new HttpError(404, 'Comment not found');
  }
  db.run('DELETE FROM comments WHERE id = ?', [comment.id]);
  return json({ ok: true });
}
