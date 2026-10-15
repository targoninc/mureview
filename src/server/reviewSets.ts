import type { ForgeKind, ReviewSet, ReviewSetDetail, ReviewSetInput, ReviewSetRepo } from '../shared/types';
import { loadReadableReviewSetRow, ownerInfo, reposAccessible, reviewSetRow, type OwnerInfo, type ReviewSetRow } from './access';
import { mapLimit } from './cache';
import { type ForgeConnectionRow, type UserRow, db } from './db';
import { hostOf, organizationOf } from './forges';
import { HttpError, json, readJson, requireString } from './http';
import { buildPrStatus, clientsForActor } from './pr';
import { canManageRepoList, canManageReviewSet } from './permissions';
import { listComments } from './comments';
import { syncForgeComments } from './commentSync';
import { ensureWebhooksForReviewSet } from './webhooks';
import { listReviewed } from './reviewed';
import { readRun } from './progress';
import { normalizeRepo } from './repos';
import { connectionsFor } from './auth/identities';
import type { Ctx } from './router';

interface RepoRow {
  connection_id: number;
  repo: string;
  branch: string | null;
  target_branch: string | null;
  position: number;
  kind: ForgeKind;
  base_url: string;
}

function reposFor(reviewSetId: number): ReviewSetRepo[] {
  return db
    .query<RepoRow, [number]>(
      `SELECT rsr.connection_id, rsr.repo, rsr.branch, rsr.target_branch, rsr.position, fc.kind, fc.base_url
       FROM review_set_repos rsr
       JOIN forge_connections fc ON fc.id = rsr.connection_id
       WHERE rsr.review_set_id = ?
       ORDER BY fc.kind, fc.base_url, rsr.repo, rsr.position`,
    )
    .all(reviewSetId)
    .map((row) => ({
      connectionId: row.connection_id,
      repo: row.repo,
      kind: row.kind,
      host: hostOf(row.base_url),
      org: organizationOf(row.base_url),
      branch: row.branch,
      target: row.target_branch,
      position: row.position,
    }));
}

function toReviewSet(row: ReviewSetRow): ReviewSet {
  return {
    id: row.id,
    name: row.name,
    repos: reposFor(row.id),
    mode: row.mode === 'per-repo' || row.mode === 'stack' ? row.mode : 'pattern',
    branchRegex: row.branch_regex,
    targetBranch: row.target_branch,
    createdAt: row.created_at,
  };
}

export function loadOwnedReviewSet(user: UserRow, id: number): ReviewSet {
  const row = reviewSetRow(id);
  if (!row || row.owner_id !== user.id) throw new HttpError(404, 'Review set not found');
  return toReviewSet(row);
}

export interface ReadableReviewSet {
  reviewSet: ReviewSet;
  ownerId: number;
  owned: boolean;
  owner: OwnerInfo | null;
}

export async function loadReadableReviewSet(user: UserRow, id: number): Promise<ReadableReviewSet> {
  const access = await loadReadableReviewSetRow(user.id, id);
  return { reviewSet: toReviewSet(access.row), ownerId: access.row.owner_id, owned: access.owned, owner: access.owner };
}

export function requireId(ctx: Ctx): number {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Review set not found');
  return id;
}

/** Maps a submitted connection id to the connection to store, or null when it is unknown. */
type ConnectionResolver = (connectionId: number) => number | null;

function parseInput(user: UserRow, body: unknown, resolveConnection?: ConnectionResolver): ReviewSetInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const name = requireString(record.name, 'name', 200);
  const mode: ReviewSetInput['mode'] = record.mode === 'per-repo' || record.mode === 'stack' ? record.mode : 'pattern';

  const raw = Array.isArray(record.repos) ? record.repos : [];
  const own = new Set(connectionsFor(user.id).map((connection) => connection.id));
  const resolve = resolveConnection ?? ((connectionId: number) => (own.has(connectionId) ? connectionId : null));
  const repos: ReviewSetInput['repos'] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const item = (entry ?? {}) as { connectionId?: unknown; repo?: unknown; branch?: unknown; target?: unknown; position?: unknown };
    const submitted = Number(item.connectionId);
    const connectionId = Number.isInteger(submitted) ? resolve(submitted) : null;
    if (connectionId === null) {
      throw new HttpError(400, 'Every repository must reference one of your forge connections.');
    }
    const repo = typeof item.repo === 'string' ? normalizeRepo(item.repo) : null;
    if (!repo) throw new HttpError(400, `"${String(item.repo)}" is not a valid repository name. Use "owner/name".`);

    const branch = typeof item.branch === 'string' && item.branch.trim() ? item.branch.trim().slice(0, 255) : null;
    const target = typeof item.target === 'string' && item.target.trim() ? item.target.trim().slice(0, 255) : null;
    const position = Number.isInteger(Number(item.position)) && Number(item.position) >= 0 ? Number(item.position) : 0;

    if (mode === 'stack') {
      if (!branch) throw new HttpError(400, `Every layer of a stack needs a branch (${repo}).`);
      const key = `${connectionId}:${repo}:${position}`;
      if (seen.has(key)) continue;
      seen.add(key);
    } else {
      const key = `${connectionId}:${repo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (mode === 'per-repo' && (!branch || !target)) {
        throw new HttpError(400, `Pick a source and target branch for ${repo}.`);
      }
    }
    repos.push({ connectionId, repo, branch, target: mode === 'stack' ? null : target, position: mode === 'stack' ? position : 0 });
  }

  if (!repos.length) throw new HttpError(400, 'Add at least one repository.');
  if (repos.length > 50) throw new HttpError(400, 'A review set can include at most 50 repositories.');

  if (mode === 'stack') {
    // Every repository's layers must be numbered 0..n-1 without gaps, and no
    // branch may appear twice in one stack.
    const byRepo = new Map<string, { positions: number[]; branches: string[] }>();
    for (const repo of repos) {
      const key = `${repo.connectionId}:${repo.repo}`;
      const group = byRepo.get(key) ?? { positions: [], branches: [] };
      group.positions.push(repo.position ?? 0);
      group.branches.push(repo.branch!);
      byRepo.set(key, group);
    }
    for (const [key, group] of byRepo) {
      const sorted = [...group.positions].sort((a, b) => a - b);
      if (sorted.some((position, index) => position !== index)) {
        throw new HttpError(400, `The layers of ${key.split(':')[1]} must be numbered in order without gaps.`);
      }
      if (new Set(group.branches).size !== group.branches.length) {
        throw new HttpError(400, `A branch can only appear once in the stack of ${key.split(':')[1]}.`);
      }
    }
  }

  const branchRegex = mode === 'pattern' ? requireString(record.branchRegex, 'branchRegex', 500) : '';
  // Per-repo sets target each repository separately, so the set-level target
  // is optional there; pattern and stack sets need one.
  const targetBranch =
    mode === 'per-repo'
      ? (typeof record.targetBranch === 'string' ? record.targetBranch.trim().slice(0, 255) : '')
      : requireString(record.targetBranch, 'targetBranch', 255);
  return { name, repos, mode, branchRegex, targetBranch };
}

function saveRepos(reviewSetId: number, repos: ReviewSetInput['repos']): void {
  const apply = db.transaction(() => {
    db.run('DELETE FROM review_set_repos WHERE review_set_id = ?', [reviewSetId]);
    for (const repo of repos) {
      db.run(
        'INSERT INTO review_set_repos (review_set_id, connection_id, repo, position, branch, target_branch) VALUES (?, ?, ?, ?, ?, ?)',
        [reviewSetId, repo.connectionId, repo.repo, repo.position ?? 0, repo.branch ?? null, repo.target ?? null],
      );
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
  const access = await loadReadableReviewSet(user, id);
  const connections = connectionsFor(access.ownerId);
  const clients = clientsForActor(user.id, connections);
  const [pr, canManage] = await Promise.all([
    buildPrStatus(connections, access.reviewSet, fresh, {
      commits: false,
      ensurePulls: false,
      progress: true,
      progressUserId: user.id,
      viewerId: user.id,
      clients,
    }),
    canManageReviewSet(user.id, access.reviewSet, connections),
  ]);
  return { reviewSet: access.reviewSet, pr, owned: access.owned, owner: access.owner, canManage };
}

/** What the review set load is doing right now, for the loading screen. */
export function getReviewSetProgress(ctx: Ctx): Response {
  const user = ctx.user!;
  return json({ progress: readRun(user.id, requireId(ctx)) });
}

/**
 * Streams the detail as the repositories finish, so the diff can appear as
 * soon as the first repository is ready and the rest fill in lazily. Lines:
 * `{reviewSet, owned, owner}`, `{canManage}`, `{repo}` per repository,
 * `{done: PrStatus}` or `{error}`.
 */
export async function streamReviewSetDetail(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const fresh = isFresh(ctx);
  const connections = connectionsFor(access.ownerId);
  const clients = clientsForActor(user.id, connections);
  if (fresh && !(await canManageReviewSet(user.id, access.reviewSet, connections))) {
    throw new HttpError(403, 'You need merge permission on every repository in this review set to refresh it.');
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client went away; further writes are pointless but harmless.
        }
      };
      try {
        send({ reviewSet: access.reviewSet, owned: access.owned, owner: access.owner });
        const permission = canManageReviewSet(user.id, access.reviewSet, connections)
          .then((canManage) => send({ canManage }))
          .catch(() => send({ canManage: false }));
        const pr = await buildPrStatus(connections, access.reviewSet, fresh, {
          commits: false,
          ensurePulls: false,
          progress: true,
          progressUserId: user.id,
          onRepo: (repo) => send({ repo }),
          clients,
        });
        send({ done: pr });
        await permission;
      } catch (error) {
        console.error('Could not stream the review set detail:', error);
        send({ error: 'Could not load the review set.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function getReviewSetCommits(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const connections = connectionsFor(access.ownerId);
  const status = await buildPrStatus(connections, access.reviewSet, false, {
    discussions: false,
    commits: true,
    ensurePulls: false,
    clients: clientsForActor(user.id, connections),
  });
  return json({
    repos: status.repos.map((repo) => ({
      connectionId: repo.connectionId,
      repo: repo.repo,
      position: repo.position,
      commits: repo.commits ?? [],
    })),
  });
}

/** The checks of every matched branch, for the pull request list. */
export async function getReviewSetChecks(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const connections = connectionsFor(access.ownerId);
  const clients = clientsForActor(user.id, connections);
  const status = await buildPrStatus(connections, access.reviewSet, false, {
    discussions: false,
    commits: false,
    ensurePulls: false,
    clients,
  });
  const open = status.repos.filter((repo) => repo.state === 'open' && repo.branch);

  const repos = await mapLimit(open, 3, async (repo) => {
    const client = clients.get(repo.connectionId);
    if (!client)
      return { connectionId: repo.connectionId, repo: repo.repo, position: repo.position, checks: { state: 'unknown' as const, runs: [] } };
    try {
      const head = await client.getBranch(repo.repo, repo.branch!, {});
      if (!head)
        return { connectionId: repo.connectionId, repo: repo.repo, position: repo.position, checks: { state: 'none' as const, runs: [] } };
      return {
        connectionId: repo.connectionId,
        repo: repo.repo,
        position: repo.position,
        checks: await client.checks(repo.repo, head.sha, { pullRequest: repo.pullRequest?.ref }),
      };
    } catch (error) {
      console.error(`Could not read the checks for ${repo.repo}:`, error);
      return { connectionId: repo.connectionId, repo: repo.repo, position: repo.position, checks: { state: 'unknown' as const, runs: [] } };
    }
  });

  return json({ repos });
}

/**
 * The slower enrichment: ensures the forge pull requests exist, imports new
 * forge comments (throttled) and reports the attached pull request links.
 */
export async function getReviewSetDiscussion(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const connections = connectionsFor(access.ownerId);
  // Creating forge pull requests is a write: only viewers who may merge every
  // branch trigger it, and they do it with their own credentials.
  const canManage = await canManageReviewSet(user.id, access.reviewSet, connections);
  const clients = clientsForActor(user.id, connections);
  const status = await buildPrStatus(connections, access.reviewSet, false, {
    discussions: false,
    commits: false,
    ensurePulls: canManage,
    clients,
  });

  if (status.prId && status.state === 'open') {
    const targets = db
      .query<{ connection_id: number; repo: string; position: number; forge_pr_ref: string }, [number]>(
        'SELECT connection_id, repo, position, forge_pr_ref FROM pull_request_repos WHERE pr_id = ?',
      )
      .all(status.prId)
      .map((row) => ({ connectionId: row.connection_id, repo: row.repo, position: row.position, pullRequestRef: row.forge_pr_ref }));
    await syncForgeComments(status.prId, clients, targets, ctx.url.searchParams.get('sync') === 'force');
  }

  return json({
    comments: status.prId ? listComments(status.prId) : [],
    reviewed: status.prId ? listReviewed(status.prId, user.id) : [],
    pullRequests: status.repos
      .filter((repo) => repo.pullRequest)
      .map((repo) => ({ connectionId: repo.connectionId, repo: repo.repo, position: repo.position, ...repo.pullRequest! })),
    // Why creating a forge pull request failed, so the review page can say it.
    prErrors: status.repos
      .filter((repo) => repo.prError)
      .map((repo) => ({ connectionId: repo.connectionId, repo: repo.repo, position: repo.position, message: repo.prError! })),
  });
}

export async function listReviewSets(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const rows = db.query<ReviewSetRow, []>('SELECT * FROM review_sets ORDER BY name COLLATE NOCASE').all();
  const reviewSets: ReviewSet[] = [];
  const foreign: ReviewSetRow[] = [];
  for (const row of rows) {
    if (row.owner_id === user.id) reviewSets.push(toReviewSet(row));
    else foreign.push(row);
  }

  const sharedReviewSets: ReviewSet[] = [];
  await mapLimit(foreign, 3, async (row) => {
    const reviewSet = toReviewSet(row);
    if (!(await reposAccessible(user.id, reviewSet.repos))) return;
    sharedReviewSets.push({ ...reviewSet, owner: ownerInfo(row.owner_id) });
  });
  sharedReviewSets.sort((a, b) => a.name.localeCompare(b.name));

  return json({ reviewSets, sharedReviewSets });
}

export async function createReviewSet(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const input = parseInput(user, await readJson(ctx.req));
  const inserted = db.run('INSERT INTO review_sets (owner_id, name, mode, branch_regex, target_branch) VALUES (?, ?, ?, ?, ?)', [
    user.id,
    input.name,
    input.mode,
    input.branchRegex,
    input.targetBranch,
  ]);
  const id = Number(inserted.lastInsertRowid);
  saveRepos(id, input.repos);
  // The review itself is built by the review page's stream, so saving stays
  // quick and the page can show what is loading repository by repository.
  void ensureWebhooksForReviewSet(id);
  return json({ detail: { reviewSet: toReviewSet(reviewSetRow(id)!), owned: true } }, 201);
}

/**
 * Repositories a non-owner submits are resolved to the owner's connections so
 * the review set stays bound to its owner. Repositories the editor adds must
 * still be reachable with their own connections.
 */
async function parseForeignInput(
  user: UserRow,
  reviewSet: ReviewSet,
  ownerConnections: ForgeConnectionRow[],
  body: unknown,
): Promise<ReviewSetInput> {
  const ownerById = new Map(ownerConnections.map((connection) => [connection.id, connection]));
  const own = connectionsFor(user.id);
  const usedBySet = new Set(reviewSet.repos.map((repo) => repo.connectionId));
  const input = parseInput(user, body, (submitted) => {
    const owner = ownerById.get(submitted);
    if (owner) return owner.id;
    const actor = own.find((connection) => connection.id === submitted);
    if (!actor) return null;
    const candidates = ownerConnections.filter(
      (connection) =>
        connection.kind === actor.kind &&
        hostOf(connection.base_url) === hostOf(actor.base_url) &&
        (actor.kind !== 'ado' || organizationOf(connection.base_url) === organizationOf(actor.base_url)),
    );
    const preferred = candidates.find((connection) => usedBySet.has(connection.id)) ?? candidates[0];
    return preferred?.id ?? null;
  });

  const repos = input.repos.map((repo) => {
    const connection = ownerById.get(repo.connectionId)!;
    return { kind: connection.kind, host: hostOf(connection.base_url), org: organizationOf(connection.base_url), repo: repo.repo };
  });
  if (!(await reposAccessible(user.id, repos))) {
    throw new HttpError(403, 'You can only use repositories you can reach with your own connections.');
  }
  if (!(await canManageRepoList(user.id, input.repos, ownerConnections))) {
    throw new HttpError(403, 'You need merge permission on every repository in this review set.');
  }
  return input;
}

export async function updateReviewSet(ctx: Ctx): Promise<Response> {
  const user = ctx.user!;
  const id = requireId(ctx);
  const access = await loadReadableReviewSet(user, id);
  const connections = connectionsFor(access.ownerId);
  if (!(await canManageReviewSet(user.id, access.reviewSet, connections))) {
    throw new HttpError(403, 'You need merge permission on every repository in this review set to change its settings.');
  }
  const body = await readJson(ctx.req);
  const input = access.owned ? parseInput(user, body) : await parseForeignInput(user, access.reviewSet, connections, body);
  db.run('UPDATE review_sets SET name = ?, mode = ?, branch_regex = ?, target_branch = ? WHERE id = ?', [
    input.name,
    input.mode,
    input.branchRegex,
    input.targetBranch,
    id,
  ]);
  saveRepos(id, input.repos);
  // Permission was required to get here, so the editor can manage the set.
  void ensureWebhooksForReviewSet(id);
  return json({ detail: { reviewSet: toReviewSet(reviewSetRow(id)!), owned: access.owned, canManage: true } });
}

export function deleteReviewSet(ctx: Ctx): Response {
  const user = ctx.user!;
  const result = db.run('DELETE FROM review_sets WHERE id = ? AND owner_id = ?', [requireId(ctx), user.id]);
  if (result.changes === 0) throw new HttpError(404, 'Review set not found');
  return json({ ok: true });
}
