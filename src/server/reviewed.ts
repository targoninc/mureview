import type { ReviewMark } from '../shared/types';
import { requireUser } from './auth/session';
import { loadReadablePr } from './comments';
import { db } from './db';
import { HttpError, json, readJson } from './http';
import { publishForPr } from './live';
import type { Ctx } from './router';

/** The files the user marked as viewed; everyone keeps their own marks. */
export function listReviewed(prId: number, userId: number): ReviewMark[] {
  return db
    .query<ReviewMark, [number, number]>(
      'SELECT connection_id AS connectionId, repo, position, path FROM reviewed_files WHERE pr_id = ? AND user_id = ? ORDER BY connection_id, repo, position, path',
    )
    .all(prId, userId);
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
    reviewed,
    itemIds: marks.map((mark) => `${mark.connectionId}:${mark.repo}:${mark.position}:${mark.path}`),
  });
  return json({ ok: true, count: marks.length });
}
