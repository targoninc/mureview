import type { Comment, CommentInput } from '../shared/types';
import { loadReadableReviewSetRow } from './access';
import { connectionById, connectionsFor } from './auth/identities';
import { publicUser, requireUser } from './auth/session';
import { type ForgeConnectionRow, db } from './db';
import { clientFor } from './forges';
import { hostOf, organizationOf } from './forges/types';
import { HttpError, json, readJson } from './http';
import { markCommentSynced, repoPullRequest } from './pullRequests';
import type { Ctx } from './router';

interface CommentRow {
  id: number;
  pr_id: number;
  connection_id: number | null;
  author_id: number | null;
  author_name: string;
  author_avatar: string;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  body: string;
  synced_at: string | null;
  forge_comment_id: string | null;
  parent_id: number | null;
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
      avatarUrl: proxiedAvatar(row.connection_id, row.author_avatar),
    },
    authorId: row.author_id,
    connectionId: row.connection_id,
    repo: row.repo,
    path: row.path,
    line: row.line,
    side: row.side === 'additions' || row.side === 'deletions' ? row.side : null,
    body: row.body,
    synced: row.synced_at !== null,
    source: row.source === 'forge' ? 'forge' : 'mureview',
    forgeCommentId: row.forge_comment_id,
    parentId: row.parent_id,
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

/** Loads a pull request the user may read: their own or a shared review set's. */
async function loadReadablePr(userId: number, id: number): Promise<PrRow> {
  const pr = db.query<PrRow, [number]>('SELECT id, review_set_id, closed_at FROM pull_requests WHERE id = ?').get(id);
  if (!pr) throw new HttpError(404, 'Pull request not found');
  const access = await loadReadableReviewSetRow(userId, pr.review_set_id);
  return { ...pr, owner_id: access.row.owner_id };
}

/**
 * Comments always carry the commenting user as their author, also on review
 * sets owned by someone else. Line comments must point at one of the review
 * set's repositories, which reference the owner's connections.
 */
function normalizeAnchor(reviewSetId: number, input: CommentInput) {
  if (!input.path) return { connectionId: null, repo: null, path: null, line: null, side: null };
  const connectionId = Number(input.connectionId);
  if (!Number.isInteger(connectionId)) throw new HttpError(400, 'A valid connection is required for line comments.');
  if (typeof input.repo !== 'string' || !input.repo) throw new HttpError(400, 'A repository is required for line comments.');
  const known = db
    .query<{ repo: string }, [number, number, string]>(
      'SELECT repo FROM review_set_repos WHERE review_set_id = ? AND connection_id = ? AND repo = ?',
    )
    .get(reviewSetId, connectionId, input.repo);
  if (!known) throw new HttpError(400, 'That file does not belong to this review set.');
  if (!Number.isInteger(input.line) || (input.line as number) < 1) throw new HttpError(400, 'A line number is required for line comments.');
  if (input.side !== 'additions' && input.side !== 'deletions') throw new HttpError(400, 'A valid diff side is required for line comments.');
  return { connectionId, repo: input.repo, path: input.path, line: input.line, side: input.side };
}

export async function listCommentsRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = await loadReadablePr(user.id, Number(ctx.params.id));
  return json({ comments: listComments(pr.id) });
}

export async function createCommentRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = await loadReadablePr(user.id, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Comments are only kept while it is open.');

  const input = await readJson<CommentInput>(ctx.req);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new HttpError(400, 'Write something before commenting.');
  if (body.length > 10_000) throw new HttpError(400, 'Comments are limited to 10000 characters.');

  let parentId: number | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    const candidate = Number(input.parentId);
    const parent = Number.isInteger(candidate)
      ? db.query<{ id: number }, [number, number]>('SELECT id FROM comments WHERE id = ? AND pr_id = ?').get(candidate, pr.id)
      : null;
    if (!parent) throw new HttpError(400, 'The comment you are replying to no longer exists.');
    parentId = parent.id;
  }

  const anchor = normalizeAnchor(pr.review_set_id, input);
  const inserted = db.run(
    'INSERT INTO comments (pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, parent_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [pr.id, user.id, publicUser(user).name, user.avatar_url, anchor.connectionId, anchor.repo, anchor.path, anchor.line, anchor.side, body, parentId, 'mureview'],
  );
  const commentId = Number(inserted.lastInsertRowid);
  const row = db.query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.id = ?`).get(commentId)!;
  await syncCommentToPullRequest(user.id, pr.id, row);
  const synced = db.query<CommentRow, [number]>(`${SELECT_COMMENT} WHERE c.id = ?`).get(commentId)!;
  return json({ comment: toComment(synced) }, 201);
}

/**
 * Line comments are mirrored onto the repository's forge pull request right
 * away; general comments stay in mureview. Replies continue the forge thread
 * when the comment being answered already exists there. Comments on someone
 * else's review set are posted with the commenting user's own connection, so
 * the forge shows them as the real author.
 */
async function syncCommentToPullRequest(userId: number, prId: number, row: CommentRow): Promise<void> {
  if (!row.path || row.connection_id === null || !row.repo || row.line === null || !row.side) return;
  const pull = repoPullRequest(prId, row.connection_id, row.repo);
  if (!pull) return;
  const connection = connectionForComment(userId, row.connection_id);
  if (!connection) return;
  const parent = row.parent_id
    ? db.query<{ forge_comment_id: string | null }, [number]>('SELECT forge_comment_id FROM comments WHERE id = ?').get(row.parent_id)
    : null;
  try {
    const posted = await clientFor(connection).postReviewComment(row.repo, pull.forge_pr_number, {
      body: row.body,
      path: row.path,
      line: row.line,
      side: row.side as 'additions' | 'deletions',
      commitId: pull.head_sha || undefined,
      replyTo: parent?.forge_comment_id ?? undefined,
    });
    markCommentSynced(row.id, posted.id);
    // The forge names the account the comment ended up under; show that
    // account instead of the mureview sign-in identity.
    if (posted.author && (posted.author.name || posted.author.avatarUrl)) {
      db.run(
        "UPDATE comments SET author_name = COALESCE(NULLIF(?, ''), author_name), author_avatar = COALESCE(NULLIF(?, ''), author_avatar) WHERE id = ?",
        [posted.author.name, posted.author.avatarUrl, row.id],
      );
    }
  } catch (error) {
    console.error(`Could not sync comment ${row.id} to the forge:`, error);
  }
}

/**
 * The connection to act on a review set repository with: the user's own
 * connection when the repository is theirs, otherwise their connection to the
 * same forge and organization as the review set's connection.
 */
function connectionForComment(userId: number, ownerConnectionId: number): ForgeConnectionRow | null {
  const ownerConnection = db
    .query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?')
    .get(ownerConnectionId);
  if (!ownerConnection) return null;
  return connectionById(userId, ownerConnection.id) ?? matchingConnection(userId, ownerConnection);
}

/** The user's own connection to the same forge and organization. */
function matchingConnection(userId: number, ownerConnection: ForgeConnectionRow): ForgeConnectionRow | null {
  const host = hostOf(ownerConnection.base_url);
  const org = organizationOf(ownerConnection.base_url);
  return (
    connectionsFor(userId).find(
      (candidate) =>
        candidate.kind === ownerConnection.kind &&
        hostOf(candidate.base_url) === host &&
        (org === null || organizationOf(candidate.base_url) === org),
    ) ?? null
  );
}

/**
 * Only a comment's own author may delete it. The comment is removed on the
 * forge first: when that fails nothing changes locally, otherwise a later
 * sync would simply import the comment again (without its author).
 */
export async function deleteCommentRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const comment = db
    .query<
      { id: number; author_id: number | null; connection_id: number | null; repo: string | null; pr_id: number; forge_comment_id: string | null },
      [number]
    >('SELECT id, author_id, connection_id, repo, pr_id, forge_comment_id FROM comments WHERE id = ?')
    .get(Number(ctx.params.id));
  if (!comment || comment.author_id === null || comment.author_id !== user.id) {
    throw new HttpError(404, 'Comment not found');
  }

  if (comment.forge_comment_id && comment.connection_id !== null && comment.repo) {
    const pull = repoPullRequest(comment.pr_id, comment.connection_id, comment.repo);
    const connection = pull ? connectionForComment(user.id, comment.connection_id) : null;
    if (pull && connection) {
      try {
        await clientFor(connection).deleteComment(comment.repo, pull.forge_pr_number, comment.forge_comment_id);
      } catch (error) {
        console.error(`Could not delete comment ${comment.id} on the forge:`, error);
        throw new HttpError(502, 'The comment could not be deleted on the forge, so it was kept here. Try again later.');
      }
    }
  }

  db.run('DELETE FROM comments WHERE id = ?', [comment.id]);
  return json({ ok: true });
}
