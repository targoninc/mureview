import type { ReviewMark } from '../shared/types';
import { requireUser } from './auth';
import { loadOwnedPr } from './comments';
import { db } from './db';
import { HttpError, json, readJson } from './http';
import type { Ctx } from './router';

export function listReviewed(prId: number): ReviewMark[] {
  return db
    .query<ReviewMark, [number]>('SELECT repo, path FROM reviewed_files WHERE pr_id = ? ORDER BY repo, path')
    .all(prId);
}

interface ReviewedInput {
  reviewed?: unknown;
  repo?: unknown;
  path?: unknown;
  files?: unknown;
}

const maxBatch = 5000;

function parseMark(value: unknown): ReviewMark {
  const record = (value ?? {}) as { repo?: unknown; path?: unknown };
  if (typeof record.repo !== 'string' || !record.repo) throw new HttpError(400, 'Each file needs a "repo".');
  if (typeof record.path !== 'string' || !record.path) throw new HttpError(400, 'Each file needs a "path".');
  if (record.path.length > 1000) throw new HttpError(400, '"path" is too long.');
  return { repo: record.repo, path: record.path };
}

export async function setReviewedRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Reviewed files only live while it is open.');

  const input = await readJson<ReviewedInput>(ctx.req);
  if (typeof input.reviewed !== 'boolean') throw new HttpError(400, '"reviewed" must be a boolean');
  const reviewed = input.reviewed;

  const marks: ReviewMark[] = Array.isArray(input.files)
    ? input.files.map(parseMark)
    : [parseMark({ repo: input.repo, path: input.path })];
  if (!marks.length) throw new HttpError(400, 'No files given.');
  if (marks.length > maxBatch) throw new HttpError(400, `At most ${maxBatch} files per request.`);

  const apply = db.transaction((entries: ReviewMark[]) => {
    for (const entry of entries) {
      if (reviewed) {
        db.run('INSERT OR IGNORE INTO reviewed_files (pr_id, repo, path) VALUES (?, ?, ?)', [pr.id, entry.repo, entry.path]);
      } else {
        db.run('DELETE FROM reviewed_files WHERE pr_id = ? AND repo = ? AND path = ?', [pr.id, entry.repo, entry.path]);
      }
    }
  });
  apply(marks);
  return json({ ok: true, count: marks.length });
}
