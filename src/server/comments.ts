import type { Comment, CommentInput } from '../shared/types';
import type { UserRow } from './auth';
import { requireUser } from './auth';
import { db } from './db';
import { HttpError, json, readJson } from './http';
import type { Ctx } from './router';

interface CommentRow {
  id: number;
  pr_id: number;
  login: string;
  avatar_url: string;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  body: string;
  created_at: string;
}

interface PrRow {
  id: number;
  closed_at: string | null;
  owner_id: number;
}

const SELECT_COMMENT = `SELECT c.*, u.login, u.avatar_url FROM comments c JOIN users u ON u.id = c.author_id`;

function toComment(row: CommentRow): Comment {
  return {
    id: row.id,
    prId: row.pr_id,
    author: { login: row.login, avatarUrl: row.avatar_url },
    repo: row.repo,
    path: row.path,
    line: row.line,
    side: row.side === 'additions' || row.side === 'deletions' ? row.side : null,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function listComments(prId: number): Comment[] {
  const rows = db
    .query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.pr_id = ? ORDER BY c.created_at, c.id`)
    .all(prId);
  return rows.map(toComment);
}

function loadOwnedPr(user: UserRow, id: number): PrRow {
  const pr = db
    .query<PrRow, [number]>(
      `SELECT p.id, p.closed_at, r.owner_id FROM pull_requests p JOIN review_sets r ON r.id = p.review_set_id WHERE p.id = ?`,
    )
    .get(id);
  if (!pr || pr.owner_id !== user.id) throw new HttpError(404, 'Pull request not found');
  return pr;
}

function normalizeAnchor(input: CommentInput) {
  if (!input.path) return { repo: null, path: null, line: null, side: null };
  if (typeof input.repo !== 'string' || !input.repo) throw new HttpError(400, 'A repository is required for line comments.');
  if (!Number.isInteger(input.line) || (input.line as number) < 1) throw new HttpError(400, 'A line number is required for line comments.');
  if (input.side !== 'additions' && input.side !== 'deletions') throw new HttpError(400, 'A valid diff side is required for line comments.');
  return { repo: input.repo, path: input.path, line: input.line, side: input.side };
}

export function listCommentsRoute(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user, Number(ctx.params.id));
  return json({ comments: listComments(pr.id) });
}

export async function createCommentRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Comments are only kept while it is open.');

  const input = await readJson<CommentInput>(ctx.req);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new HttpError(400, 'Write something before commenting.');
  if (body.length > 10_000) throw new HttpError(400, 'Comments are limited to 10000 characters.');

  const anchor = normalizeAnchor(input);
  const inserted = db.run('INSERT INTO comments (pr_id, author_id, repo, path, line, side, body) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    pr.id,
    user.id,
    anchor.repo,
    anchor.path,
    anchor.line,
    anchor.side,
    body,
  ]);
  const row = db.query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.id = ?`).get(Number(inserted.lastInsertRowid))!;
  return json({ comment: toComment(row) }, 201);
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
