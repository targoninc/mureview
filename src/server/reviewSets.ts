import type { ReviewSet, ReviewSetDetail, ReviewSetInput } from '../shared/types';
import { requireUser, userToken, type UserRow } from './auth';
import { db } from './db';
import { HttpError, json, readJson, requireString } from './http';
import { buildPrStatus } from './pr';
import { parseRepoList } from './repos';
import type { Ctx } from './router';

interface ReviewSetRow {
  id: number;
  owner_id: number;
  name: string;
  branch_regex: string;
  target_branch: string;
  created_at: string;
}

function reposFor(reviewSetId: number): string[] {
  return db
    .query<{ repo: string }, [number]>('SELECT repo FROM review_set_repos WHERE review_set_id = ? ORDER BY repo')
    .all(reviewSetId)
    .map((row) => row.repo);
}

function toReviewSet(row: ReviewSetRow): ReviewSet {
  return {
    id: row.id,
    name: row.name,
    repos: reposFor(row.id),
    branchRegex: row.branch_regex,
    targetBranch: row.target_branch,
    createdAt: row.created_at,
  };
}

function loadOwnedReviewSet(user: UserRow, id: number): ReviewSet {
  const row = db
    .query<ReviewSetRow, [number, number]>('SELECT * FROM review_sets WHERE id = ? AND owner_id = ?')
    .get(id, user.id);
  if (!row) throw new HttpError(404, 'Review set not found');
  return toReviewSet(row);
}

function requireId(ctx: Ctx): number {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Review set not found');
  return id;
}

function parseInput(body: unknown): ReviewSetInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const name = requireString(record.name, 'name', 200);
  const branchRegex = requireString(record.branchRegex, 'branchRegex', 500);
  const targetBranch = requireString(record.targetBranch, 'targetBranch', 255);
  const raw = Array.isArray(record.repos) ? record.repos.filter((repo): repo is string => typeof repo === 'string') : [];
  const { repos, invalid } = parseRepoList(raw);
  if (invalid.length) throw new HttpError(400, `Invalid repositories: ${invalid.join(', ')}. Use the "owner/name" format.`);
  if (!repos.length) throw new HttpError(400, 'Add at least one repository.');
  if (repos.length > 50) throw new HttpError(400, 'A review set can include at most 50 repositories.');
  return { name, repos, branchRegex, targetBranch };
}

function saveRepos(reviewSetId: number, repos: string[]): void {
  const apply = db.transaction(() => {
    db.run('DELETE FROM review_set_repos WHERE review_set_id = ?', [reviewSetId]);
    for (const repo of repos) db.run('INSERT INTO review_set_repos (review_set_id, repo) VALUES (?, ?)', [reviewSetId, repo]);
  });
  apply();
}

async function buildDetail(user: UserRow, id: number): Promise<ReviewSetDetail> {
  const reviewSet = loadOwnedReviewSet(user, id);
  const pr = await buildPrStatus(userToken(user), reviewSet);
  return { reviewSet, pr };
}

export function listReviewSets(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const rows = db
    .query<ReviewSetRow, [number]>('SELECT * FROM review_sets WHERE owner_id = ? ORDER BY name COLLATE NOCASE')
    .all(user.id);
  return json({ reviewSets: rows.map(toReviewSet) });
}

export async function createReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const input = parseInput(await readJson(ctx.req));
  const inserted = db.run('INSERT INTO review_sets (owner_id, name, branch_regex, target_branch) VALUES (?, ?, ?, ?)', [
    user.id,
    input.name,
    input.branchRegex,
    input.targetBranch,
  ]);
  const id = Number(inserted.lastInsertRowid);
  saveRepos(id, input.repos);
  return json({ detail: await buildDetail(user, id) }, 201);
}

export async function getReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  return json({ detail: await buildDetail(user, requireId(ctx)) });
}

export async function updateReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const id = requireId(ctx);
  loadOwnedReviewSet(user, id);
  const input = parseInput(await readJson(ctx.req));
  db.run('UPDATE review_sets SET name = ?, branch_regex = ?, target_branch = ? WHERE id = ?', [
    input.name,
    input.branchRegex,
    input.targetBranch,
    id,
  ]);
  saveRepos(id, input.repos);
  return json({ detail: await buildDetail(user, id) });
}

export function deleteReviewSet(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const result = db.run('DELETE FROM review_sets WHERE id = ? AND owner_id = ?', [requireId(ctx), user.id]);
  if (result.changes === 0) throw new HttpError(404, 'Review set not found');
  return json({ ok: true });
}
