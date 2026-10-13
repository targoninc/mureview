import type { ForgeKind, ReviewSet, ReviewSetDetail, ReviewSetInput, ReviewSetRepo } from '../shared/types';
import { type UserRow, db } from './db';
import { hostOf, organizationOf } from './forges';
import { HttpError, json, readJson, requireString } from './http';
import { buildPrStatus, clientsFor } from './pr';
import { listComments } from './comments';
import { syncForgeComments } from './commentSync';
import { listReviewed } from './reviewed';
import { normalizeRepo } from './repos';
import { connectionsFor } from './auth/identities';
import type { Ctx } from './router';

interface ReviewSetRow {
  id: number;
  owner_id: number;
  name: string;
  branch_regex: string;
  target_branch: string;
  created_at: string;
}

interface RepoRow {
  connection_id: number;
  repo: string;
  kind: ForgeKind;
  base_url: string;
}

function reposFor(reviewSetId: number): ReviewSetRepo[] {
  return db
    .query<RepoRow, [number]>(
      `SELECT rsr.connection_id, rsr.repo, fc.kind, fc.base_url
       FROM review_set_repos rsr
       JOIN forge_connections fc ON fc.id = rsr.connection_id
       WHERE rsr.review_set_id = ?
       ORDER BY fc.kind, fc.base_url, rsr.repo`,
    )
    .all(reviewSetId)
    .map((row) => ({
      connectionId: row.connection_id,
      repo: row.repo,
      kind: row.kind,
      host: hostOf(row.base_url),
      org: organizationOf(row.base_url),
    }));
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

export function loadOwnedReviewSet(user: UserRow, id: number): ReviewSet {
  const row = db
    .query<ReviewSetRow, [number, number]>('SELECT * FROM review_sets WHERE id = ? AND owner_id = ?')
    .get(id, user.id);
  if (!row) throw new HttpError(404, 'Review set not found');
  return toReviewSet(row);
}

export function requireId(ctx: Ctx): number {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Review set not found');
  return id;
}

function parseInput(user: UserRow, body: unknown): ReviewSetInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const name = requireString(record.name, 'name', 200);
  const branchRegex = requireString(record.branchRegex, 'branchRegex', 500);
  const targetBranch = requireString(record.targetBranch, 'targetBranch', 255);

  const raw = Array.isArray(record.repos) ? record.repos : [];
  const connections = new Set(connectionsFor(user.id).map((connection) => connection.id));
  const repos: ReviewSetInput['repos'] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const item = (entry ?? {}) as { connectionId?: unknown; repo?: unknown };
    const connectionId = Number(item.connectionId);
    if (!Number.isInteger(connectionId) || !connections.has(connectionId)) {
      throw new HttpError(400, 'Every repository must reference one of your forge connections.');
    }
    const repo = typeof item.repo === 'string' ? normalizeRepo(item.repo) : null;
    if (!repo) throw new HttpError(400, `"${String(item.repo)}" is not a valid repository name. Use "owner/name".`);
    const key = `${connectionId}:${repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({ connectionId, repo });
  }

  if (!repos.length) throw new HttpError(400, 'Add at least one repository.');
  if (repos.length > 50) throw new HttpError(400, 'A review set can include at most 50 repositories.');
  return { name, repos, branchRegex, targetBranch };
}

function saveRepos(reviewSetId: number, repos: ReviewSetInput['repos']): void {
  const apply = db.transaction(() => {
    db.run('DELETE FROM review_set_repos WHERE review_set_id = ?', [reviewSetId]);
    for (const repo of repos) {
      db.run('INSERT INTO review_set_repos (review_set_id, connection_id, repo) VALUES (?, ?, ?)', [reviewSetId, repo.connectionId, repo.repo]);
    }
  });
  apply();
}

function isFresh(ctx: Ctx): boolean {
  return ctx.url.searchParams.get('fresh') === '1';
}

/**
 * The core detail response stays cheap: no forge pull request creation, no
 * comment syncing and no commit lists. Comments and reviewed files come from
 * the database so the diff renders immediately; the forge work happens in
 * parallel afterwards via the comments and commits endpoints.
 */
export async function buildDetail(user: UserRow, id: number, fresh = false): Promise<ReviewSetDetail> {
  const reviewSet = loadOwnedReviewSet(user, id);
  const pr = await buildPrStatus(connectionsFor(user.id), reviewSet, fresh, { commits: false, ensurePulls: false });
  return { reviewSet, pr };
}

export async function getReviewSetCommits(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  const status = await buildPrStatus(connectionsFor(user.id), reviewSet, false, { discussions: false, commits: true, ensurePulls: false });
  return json({
    repos: status.repos.map((repo) => ({ connectionId: repo.connectionId, repo: repo.repo, commits: repo.commits ?? [] })),
  });
}

/**
 * The slower enrichment: ensures the forge pull requests exist, imports new
 * forge comments (throttled) and reports the attached pull request links.
 */
export async function getReviewSetDiscussion(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  const connections = connectionsFor(user.id);
  const status = await buildPrStatus(connections, reviewSet, false, { discussions: false, commits: false, ensurePulls: true });

  if (status.prId && status.state === 'open') {
    const clients = clientsFor(connections);
    const targets = db
      .query<{ connection_id: number; repo: string; forge_pr_number: number }, [number]>(
        'SELECT connection_id, repo, forge_pr_number FROM pull_request_repos WHERE pr_id = ?',
      )
      .all(status.prId)
      .map((row) => ({ connectionId: row.connection_id, repo: row.repo, pullRequestNumber: row.forge_pr_number }));
    await syncForgeComments(status.prId, clients, targets, ctx.url.searchParams.get('sync') === 'force');
  }

  return json({
    comments: status.prId ? listComments(status.prId) : [],
    reviewed: status.prId ? listReviewed(status.prId) : [],
    pullRequests: status.repos
      .filter((repo) => repo.pullRequest)
      .map((repo) => ({ connectionId: repo.connectionId, repo: repo.repo, ...repo.pullRequest! })),
  });
}

export function listReviewSets(ctx: Ctx): Response {
  const user = ctx.user!;
  const rows = db
    .query<ReviewSetRow, [number]>('SELECT * FROM review_sets WHERE owner_id = ? ORDER BY name COLLATE NOCASE')
    .all(user.id);
  return json({ reviewSets: rows.map(toReviewSet) });
}

export async function createReviewSet(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const input = parseInput(user, await readJson(ctx.req));
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
  const user = ctx.user!;
  return json({ detail: await buildDetail(user, requireId(ctx), isFresh(ctx)) });
}

export async function updateReviewSet(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const id = requireId(ctx);
  loadOwnedReviewSet(user, id);
  const input = parseInput(user, await readJson(ctx.req));
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
  const user = ctx.user!;
  const result = db.run('DELETE FROM review_sets WHERE id = ? AND owner_id = ?', [requireId(ctx), user.id]);
  if (result.changes === 0) throw new HttpError(404, 'Review set not found');
  return json({ ok: true });
}
