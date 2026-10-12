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
  repo?: unknown;
  path?: unknown;
  reviewed?: unknown;
}

export async function setReviewedRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Reviewed files only live while it is open.');

  const input = await readJson<ReviewedInput>(ctx.req);
  if (typeof input.repo !== 'string' || !input.repo) throw new HttpError(400, '"repo" is required');
  if (typeof input.path !== 'string' || !input.path) throw new HttpError(400, '"path" is required');
  if (input.path.length > 1000) throw new HttpError(400, '"path" is too long');
  if (typeof input.reviewed !== 'boolean') throw new HttpError(400, '"reviewed" must be a boolean');

  if (input.reviewed) {
    db.run('INSERT OR IGNORE INTO reviewed_files (pr_id, repo, path) VALUES (?, ?, ?)', [pr.id, input.repo, input.path]);
  } else {
    db.run('DELETE FROM reviewed_files WHERE pr_id = ? AND repo = ? AND path = ?', [pr.id, input.repo, input.path]);
  }
  return json({ ok: true });
}
