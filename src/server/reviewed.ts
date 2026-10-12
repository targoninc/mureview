import type { ReviewMark } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { loadOwnedPr } from './comments';
import { db } from './db';
import { HttpError, json, readJson } from './http';
import type { Ctx } from './router';

export function listReviewed(prId: number): ReviewMark[] {
  return db
    .query<ReviewMark, [number]>('SELECT connection_id AS connectionId, repo, path FROM reviewed_files WHERE pr_id = ? ORDER BY connection_id, repo, path')
    .all(prId);
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
  const record = (value ?? {}) as { connectionId?: unknown; repo?: unknown; path?: unknown };
  const connectionId = Number(record.connectionId);
  if (!Number.isInteger(connectionId) || connectionId <= 0) throw new HttpError(400, 'Each file needs a "connectionId".');
  if (typeof record.repo !== 'string' || !record.repo) throw new HttpError(400, 'Each file needs a "repo".');
  if (typeof record.path !== 'string' || !record.path) throw new HttpError(400, 'Each file needs a "path".');
  if (record.path.length > 1000) throw new HttpError(400, '"path" is too long.');
  return { connectionId, repo: record.repo, path: record.path };
}

export async function setReviewedRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const pr = loadOwnedPr(user.id, Number(ctx.params.id));
  if (pr.closed_at) throw new HttpError(400, 'This pull request is closed. Reviewed files only live while it is open.');

  const input = await readJson<ReviewedInput>(ctx.req);
  if (typeof input.reviewed !== 'boolean') throw new HttpError(400, '"reviewed" must be a boolean');
  const reviewed = input.reviewed;

  const marks: ReviewMark[] = Array.isArray(input.files)
    ? input.files.map(parseMark)
    : [parseMark({ connectionId: input.connectionId, repo: input.repo, path: input.path })];
  if (!marks.length) throw new HttpError(400, 'No files given.');
  if (marks.length > maxBatch) throw new HttpError(400, `At most ${maxBatch} files per request.`);

  const connectionIds = new Set(connectionsFor(user.id).map((connection) => connection.id));
  for (const mark of marks) {
    if (!connectionIds.has(mark.connectionId)) throw new HttpError(400, 'A file references an unknown connection.');
  }

  const apply = db.transaction((entries: ReviewMark[]) => {
    for (const entry of entries) {
      if (reviewed) {
        db.run('INSERT OR IGNORE INTO reviewed_files (pr_id, connection_id, repo, path) VALUES (?, ?, ?, ?)', [
          pr.id,
          entry.connectionId,
          entry.repo,
          entry.path,
        ]);
      } else {
        db.run('DELETE FROM reviewed_files WHERE pr_id = ? AND connection_id = ? AND repo = ? AND path = ?', [
          pr.id,
          entry.connectionId,
          entry.repo,
          entry.path,
        ]);
      }
    }
  });
  apply(marks);
  return json({ ok: true, count: marks.length });
}
