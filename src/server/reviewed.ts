import type { ForgeKind, RepoStatus, ReviewMark, ReviewMarkBy } from '../shared/types';
import { repoLabel } from '../shared/types';
import { requireUser } from './auth/session';
import { mapLimit } from './cache';
import { loadReadablePr } from './comments';
import { db } from './db';
import { ForgeError, type ForgeClient } from './forges';
import { HttpError, json, readJson } from './http';
import { publishForPr } from './live';
import { repoPullRequest } from './pullRequests';
import type { Ctx } from './router';

/** The files the user marked as viewed; everyone keeps their own marks. */
export function listReviewed(prId: number, userId: number): ReviewMark[] {
  return db
    .query<ReviewMark, [number, number]>(
      'SELECT connection_id AS connectionId, repo, position, path FROM reviewed_files WHERE pr_id = ? AND user_id = ? ORDER BY connection_id, repo, position, path',
    )
    .all(prId, userId);
}

/** Everyone's viewed marks on a pull request, newest user first. */
export function listReviewedBy(prId: number): ReviewMarkBy[] {
  return db
    .query<
      { connectionId: number; repo: string; position: number; path: string; userId: number; name: string; avatarUrl: string },
      [number]
    >(
      `SELECT rf.connection_id AS connectionId, rf.repo, rf.position, rf.path,
              u.id AS userId, u.name, u.avatar_url AS avatarUrl
       FROM reviewed_files rf JOIN users u ON u.id = rf.user_id
       WHERE rf.pr_id = ?
       ORDER BY rf.connection_id, rf.repo, rf.position, rf.path, u.name`,
    )
    .all(prId)
    .map((row) => ({
      connectionId: row.connectionId,
      repo: row.repo,
      position: row.position,
      path: row.path,
      user: { id: row.userId, name: row.name, avatarUrl: row.avatarUrl },
    }));
}

/** A repository layer whose viewed marks a new commit invalidates. */
export interface ResetTarget {
  connectionId: number;
  repo: string;
  position: number;
}

/**
 * Clears the viewed marks on a repository layer for everyone: a new commit
 * touched those files, so they need another read. `paths` limits the reset to
 * the files the commit changed; null clears the whole layer.
 */
export function resetReviewed(prId: number, target: ResetTarget, paths: string[] | null): void {
  const rows = db
    .query<{ userId: number; name: string; avatarUrl: string; path: string }, [number, number, string, number]>(
      `SELECT rf.user_id AS userId, u.name, u.avatar_url AS avatarUrl, rf.path
       FROM reviewed_files rf JOIN users u ON u.id = rf.user_id
       WHERE rf.pr_id = ? AND rf.connection_id = ? AND rf.repo = ? AND rf.position = ?`,
    )
    .all(prId, target.connectionId, target.repo, target.position);
  const changed = paths === null ? null : new Set(paths);
  const byUser = new Map<number, { name: string; avatarUrl: string; paths: string[] }>();
  for (const row of rows) {
    if (changed && !changed.has(row.path)) continue;
    const entry = byUser.get(row.userId) ?? { name: row.name, avatarUrl: row.avatarUrl, paths: [] };
    entry.paths.push(row.path);
    byUser.set(row.userId, entry);
  }
  if (byUser.size === 0) return;

  db.transaction(() => {
    for (const [userId, entry] of byUser) {
      for (const path of entry.paths) {
        db.run(
          'DELETE FROM reviewed_files WHERE pr_id = ? AND user_id = ? AND connection_id = ? AND repo = ? AND position = ? AND path = ?',
          [prId, userId, target.connectionId, target.repo, target.position, path],
        );
      }
    }
  })();

  for (const [userId, entry] of byUser) {
    void publishForPr(prId, {
      type: 'reviewed',
      userId,
      userName: entry.name,
      userAvatar: entry.avatarUrl,
      reviewed: false,
      itemIds: entry.paths.map((path) => `${target.connectionId}:${target.repo}:${target.position}:${path}`),
    });
  }
}

/** Which tracked pull requests a forge push may belong to. */
export interface PushResetTarget {
  kind: ForgeKind;
  /** Restrict to one connection; the app webhook covers every connection of its forge. */
  connectionId?: number;
}

/**
 * A push to a tracked branch: the files it changed lose their viewed marks for
 * everyone right away, without waiting for a review set to load. Only the
 * branch whose head was seen before (`before`) is reset; anything else is left
 * to the load-time comparison.
 */
export async function resetMarksForPush(
  client: ForgeClient,
  repo: string,
  before: string,
  after: string,
  target: PushResetTarget,
): Promise<void> {
  if (!before || !after || before === after) return;
  const rows = db
    .query<{ prId: number; connectionId: number; repo: string; position: number; headSha: string }, [string, string, string]>(
      `SELECT rp.pr_id AS prId, rp.connection_id AS connectionId, rp.repo, rp.position, rp.head_sha AS headSha
       FROM pull_request_repos rp
       JOIN pull_requests p ON p.id = rp.pr_id
       JOIN forge_connections fc ON fc.id = rp.connection_id
       WHERE p.closed_at IS NULL AND fc.kind = ? AND (rp.repo = ? OR rp.repo LIKE '%/' || ?)`,
    )
    .all(target.kind, repo, repo);
  for (const row of rows) {
    if (row.headSha !== before) continue;
    if (target.connectionId !== undefined && row.connectionId !== target.connectionId) continue;
    try {
      const comparison = await client.compare(row.repo, before, after);
      resetReviewed(row.prId, row, comparison.files.map((file) => file.path));
    } catch (error) {
      console.error(`Could not compare ${row.repo} over a push to reset its viewed marks:`, error);
    }
    db.run('UPDATE pull_request_repos SET head_sha = ? WHERE pr_id = ? AND connection_id = ? AND repo = ? AND position = ?', [
      after,
      row.prId,
      row.connectionId,
      row.repo,
      row.position,
    ]);
  }
}

/**
 * When a head commit moved since it was last seen, the files it changed lose
 * their viewed marks for everyone. A branch whose old commit is gone (a force
 * push) resets its whole layer, since the change cannot be narrowed down.
 */
export async function resetMarksForNewCommits(
  clients: Map<number, ForgeClient>,
  repos: RepoStatus[],
  prId: number,
): Promise<void> {
  await mapLimit(repos, 3, async (repo) => {
    if (repo.position < 0 || repo.state !== 'open' || !repo.headSha) return;
    const row = repoPullRequest(prId, repo.connectionId, repo.repo, repo.position);
    if (!row || !row.head_sha || row.head_sha === repo.headSha) return;
    const client = clients.get(repo.connectionId);
    if (!client) return;
    try {
      const comparison = await client.compare(repo.repo, row.head_sha, repo.headSha);
      resetReviewed(prId, repo, comparison.files.map((file) => file.path));
    } catch (error) {
      // A rewritten branch no longer has the old commit; anything else is a
      // transient failure that a later load retries with the old head intact.
      if (!(error instanceof ForgeError) || (error.status !== 404 && error.status !== 422)) {
        console.error(`Could not compare the new commits of ${repoLabel(repo)}:`, error);
        return;
      }
      resetReviewed(prId, repo, null);
    }
    db.run('UPDATE pull_request_repos SET head_sha = ? WHERE pr_id = ? AND connection_id = ? AND repo = ? AND position = ?', [
      repo.headSha,
      prId,
      repo.connectionId,
      repo.repo,
      repo.position,
    ]);
  });
}

interface ReviewedInput {
  reviewed?: unknown;
  connectionId?: unknown;
  repo?: unknown;
  path?: unknown;
  files?: unknown;
}

const maxBatch = 5000;

function parseMark(value: unknown): ReviewMark {
  const record = (value ?? {}) as { connectionId?: unknown; repo?: unknown; position?: unknown; path?: unknown };
  const connectionId = Number(record.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) throw new HttpError(400, 'Each file needs a "connectionId".');
  if (typeof record.repo !== 'string' || !record.repo) throw new HttpError(400, 'Each file needs a "repo".');
  if (typeof record.path !== 'string' || !record.path) throw new HttpError(400, 'Each file needs a "path".');
  if (record.path.length > 1000) throw new HttpError(400, '"path" is too long.');
  const position = Number.isInteger(Number(record.position)) && Number(record.position) >= 0 ? Number(record.position) : 0;
  return { connectionId, repo: record.repo, position, path: record.path };
}

export async function setReviewedRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = await loadReadablePr(user.id, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Reviewed files only live while it is open.');

  const input = await readJson<ReviewedInput>(ctx.req);
  if (typeof input.reviewed !== 'boolean') throw new HttpError(400, '"reviewed" must be a boolean');
  const reviewed = input.reviewed;

  const marks: ReviewMark[] = Array.isArray(input.files)
    ? input.files.map(parseMark)
    : [parseMark({ connectionId: input.connectionId, repo: input.repo, path: input.path })];
  if (!marks.length) throw new HttpError(400, 'No files given.');
  if (marks.length > maxBatch) throw new HttpError(400, `At most ${maxBatch} files per request.`);

  for (const mark of marks) {
    const known = db
      .query<{ repo: string }, [number, number, string, number]>(
        'SELECT repo FROM review_set_repos WHERE review_set_id = ? AND connection_id = ? AND repo = ? AND position = ?',
      )
      .get(pr.review_set_id, mark.connectionId, mark.repo, mark.position);
    if (!known) throw new HttpError(400, 'A file does not belong to this review set.');
  }

  const apply = db.transaction((entries: ReviewMark[]) => {
    for (const entry of entries) {
      if (reviewed) {
        db.run('INSERT OR IGNORE INTO reviewed_files (pr_id, user_id, connection_id, repo, position, path) VALUES (?, ?, ?, ?, ?, ?)', [
          pr.id,
          user.id,
          entry.connectionId,
          entry.repo,
          entry.position,
          entry.path,
        ]);
      } else {
        db.run('DELETE FROM reviewed_files WHERE pr_id = ? AND user_id = ? AND connection_id = ? AND repo = ? AND position = ? AND path = ?', [
          pr.id,
          user.id,
          entry.connectionId,
          entry.repo,
          entry.position,
          entry.path,
        ]);
      }
    }
  });
  apply(marks);
  publishForPr(pr.id, {
    type: 'reviewed',
    userId: user.id,
    userName: user.name,
    userAvatar: user.avatar_url,
    reviewed,
    itemIds: marks.map((mark) => `${mark.connectionId}:${mark.repo}:${mark.position}:${mark.path}`),
  });
  return json({ ok: true, count: marks.length });
}
