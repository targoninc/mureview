import type { CommitInfo, FileDiff, LoadPhase, PrStatus, RepoStatus, ReviewSet } from '../shared/types';
import { repoLabel } from '../shared/types';
import { connectionOrMatching } from './auth/identities';
import { Cache, cached, mapLimit } from './cache';
import { listComments } from './comments';
import { constants } from './config';
import { type ForgeConnectionRow, db } from './db';
import { type CompareFile, type ForgeClient, clientFor } from './forges';
import { addedFilePatch, countLines } from './patch';
import { beginRun, finishRun, setPhase } from './progress';
import { attachKnownPullRequests, ensureRepoPullRequests, reviewSetPullRequest } from './pullRequests';
import { listReviewed, listReviewedBy, resetMarksForNewCommits } from './reviewed';
import { compilePatterns, forgeErrorMessage, inspectRepos, multiMatchError } from './validate';

const zeroStats = () => ({ repos: 0, files: 0, additions: 0, deletions: 0 });

interface BranchDiff {
  files: FileDiff[];
  additions: number;
  truncated: boolean;
}

const targetlessCache = new Cache<BranchDiff>(60, 60 * 60_000);
const commitsCache = new Cache<CommitInfo[]>(200, 60_000);

export function clientsFor(connections: ForgeConnectionRow[]): Map<number, ForgeClient> {
  return new Map(connections.map((connection) => [connection.id, clientFor(connection)]));
}

/**
 * Clients for acting on someone else's review set: the acting user's own
 * matching connections, keyed like the review set's connections.
 */
export function clientsForActor(actorId: number, connections: ForgeConnectionRow[]): Map<number, ForgeClient> {
  const clients = new Map<number, ForgeClient>();
  for (const connection of connections) {
    const actorConnection = connectionOrMatching(actorId, connection.id);
    if (actorConnection) clients.set(connection.id, clientFor(actorConnection));
  }
  return clients;
}

function toFileDiff(file: CompareFile): FileDiff {
  return {
    path: file.path,
    prevPath: file.prevPath,
    type: file.type,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  };
}

function summarize(files: FileDiff[]): { additions: number; deletions: number } {
  return files.reduce((acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }), {
    additions: 0,
    deletions: 0,
  });
}

function targetlessDiff(client: ForgeClient, repo: string, branchSha: string): Promise<BranchDiff> {
  return cached(targetlessCache, `${client.baseUrl}#${repo}#${branchSha}`, async () => {
    const tree = await client.listBlobs(repo, branchSha);
    const blobs = tree.blobs.filter((entry) => entry.size <= constants.maxFileBytes);
    const capped = blobs.slice(0, constants.maxRepoFiles);
    const loaded = await mapLimit(capped, 10, async (entry): Promise<FileDiff | null> => {
      const content = await client.getBlobText(repo, entry.sha);
      if (content === null) return null;
      return {
        path: entry.path,
        type: 'added',
        additions: countLines(content),
        deletions: 0,
        patch: addedFilePatch(entry.path, content),
      };
    });
    const files = loaded.filter((file): file is FileDiff => file !== null);
    return { files, additions: summarize(files).additions, truncated: tree.truncated || capped.length < blobs.length };
  });
}

async function loadCommits(
  client: ForgeClient,
  connectionId: number,
  repo: string,
  headSha: string,
  baseSha?: string,
  pullRequest?: string,
): Promise<CommitInfo[] | undefined> {
  try {
    const commits = await cached(commitsCache, `${connectionId}:${repo}:${pullRequest ?? baseSha ?? ''}:${headSha}`, () =>
      client.listCommits(repo, { headSha, baseSha, limit: 300, pullRequest }),
    );
    // Forge comparison endpoints report the oldest commit first; the commit
    // list reads newest first.
    return [...commits].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  } catch (error) {
    console.error(`Could not list commits for ${repo}:`, error);
    return undefined;
  }
}

async function inspectBranch(
  client: ForgeClient,
  status: RepoStatus,
  branchSha: string,
  fresh: boolean,
  includeCommits: boolean,
  knownPull: string | null = null,
  onPhase?: (phase: 'diffing' | 'done' | 'error') => void,
): Promise<RepoStatus> {
  const repo = status.repo;
  const target = status.target;
  onPhase?.('diffing');
  try {
    const targetRef = await client.getBranch(repo, target, { fresh });
    if (!targetRef) {
      const diff = await targetlessDiff(client, repo, branchSha);
      onPhase?.('done');
      return {
        ...status,
        targetExists: false,
        state: 'open',
        headSha: branchSha,
        aheadBy: diff.files.length,
        additions: diff.additions,
        deletions: 0,
        truncated: diff.truncated,
        commits: includeCommits ? await loadCommits(client, status.connectionId, repo, branchSha, undefined, knownPull ?? undefined) : undefined,
        files: diff.files,
      };
    }

    const comparison = await client.compare(repo, targetRef.sha, branchSha);
    if (comparison.merged) {
      onPhase?.('done');
      return {
        ...status,
        targetExists: true,
        state: 'merged',
        headSha: branchSha,
        aheadBy: comparison.aheadBy,
        behindBy: comparison.behindBy,
        commits: [],
      };
    }

    const files = comparison.files.map(toFileDiff);
    const totals = summarize(files);
    const loaded = includeCommits
      ? await loadCommits(client, status.connectionId, repo, branchSha, targetRef.sha, knownPull ?? undefined)
      : undefined;
    // The comparison already carries the first page of commits; keep them when
    // the separate commit listing comes back empty.
    const commits = loaded?.length === 0 && comparison.commits.length > 0 ? comparison.commits : loaded;
    // A layer of a stack is supposed to build on the branch below it; when the
    // forge reports a different merge base, the stack is out of order.
    const diverged =
      status.position > 0 && comparison.mergeBase && comparison.mergeBase !== targetRef.sha
        ? `This layer's branch does not build on ${target}; they split at ${comparison.mergeBase.slice(0, 7)}.`
        : undefined;
    onPhase?.('done');
    return {
      ...status,
      targetExists: true,
      state: 'open',
      headSha: branchSha,
      aheadBy: comparison.aheadBy,
      behindBy: comparison.behindBy,
      additions: totals.additions,
      deletions: totals.deletions,
      truncated: comparison.truncated,
      commits,
      commitsTruncated: commits !== undefined && comparison.aheadBy > commits.length,
      note: [status.note, diverged].filter(Boolean).join(' ') || undefined,
      files,
    };
  } catch (error) {
    onPhase?.('error');
    return { ...status, error: `Could not build the diff for ${repoLabel(status)} (${forgeErrorMessage(error)}).`, state: 'error' };
  }
}

interface PrLifecycleResult {
  prId: number | null;
  justClosed: boolean;
}

function ensurePrLifecycle(reviewSetId: number, hasOpenRepos: boolean): PrLifecycleResult {
  const existing = db
    .query<{ id: number }, [number]>('SELECT id FROM pull_requests WHERE review_set_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1')
    .get(reviewSetId);

  if (hasOpenRepos) {
    if (existing) return { prId: existing.id, justClosed: false };
    const inserted = db.run('INSERT INTO pull_requests (review_set_id) VALUES (?)', [reviewSetId]);
    return { prId: Number(inserted.lastInsertRowid), justClosed: false };
  }

  if (existing) {
    db.run(`UPDATE pull_requests SET closed_at = datetime('now') WHERE id = ?`, [existing.id]);
    db.run('DELETE FROM comments WHERE pr_id = ?', [existing.id]);
    db.run('DELETE FROM reviewed_files WHERE pr_id = ?', [existing.id]);
    return { prId: null, justClosed: true };
  }
  return { prId: null, justClosed: false };
}

export interface BuildPrOptions {
  /** Include comments and reviewed files (reads the database only). */
  discussions?: boolean;
  /** Include the per-repository commit list (extra forge calls on cold caches). */
  commits?: boolean;
  /** Create missing forge pull requests for open repositories. */
  ensurePulls?: boolean;
  /** Clear viewed marks on files a new head commit changed. */
  headSync?: boolean;
  /** Report per-repository progress for the loading screen. */
  progress?: boolean;
  progressUserId?: number;
  /** Called with each repository as soon as its status is known. */
  onRepo?: (repo: RepoStatus) => void;
  /** Whose viewed marks to include (they are per user). */
  viewerId?: number;
  /** Use these clients instead of building them from the connections. */
  clients?: Map<number, ForgeClient>;
}

export async function buildPrStatus(
  connections: ForgeConnectionRow[],
  reviewSet: ReviewSet,
  fresh = false,
  options: BuildPrOptions = {},
): Promise<PrStatus> {
  const includeDiscussions = options.discussions ?? true;
  const includeCommits = options.commits ?? true;
  const ensurePulls = options.ensurePulls ?? true;
  const errors: string[] = [];
  const clients = options.clients ?? clientsFor(connections);
  const perRepo = reviewSet.mode === 'per-repo';
  const stacked = reviewSet.mode === 'stack';
  const compiled = perRepo || stacked ? { patterns: [] as RegExp[], error: null } : compilePatterns(reviewSet.branchRegex);
  if (compiled.error) errors.push(compiled.error);

  const layerLabel = (repo: ReviewSet['repos'][number]) =>
    stacked && repo.branch ? `${repoLabel(repo)} · ${repo.branch}` : repoLabel(repo);

  const reporting = options.progress === true && options.progressUserId !== undefined;
  if (reporting) {
    beginRun(
      options.progressUserId!,
      reviewSet.id,
      reviewSet.repos.map((repo) => ({ key: `${repo.connectionId}:${repo.repo}:${repo.position}`, label: layerLabel(repo) })),
    );
  }
  const phase = (connectionId: number, repo: string, position: number, value: LoadPhase) => {
    if (reporting) setPhase(reviewSet.id, `${connectionId}:${repo}:${position}`, value);
  };

  try {
    const located = await inspectRepos(
      clients,
      reviewSet.repos,
      { patterns: compiled.patterns, perRepo, stack: stacked, defaultTarget: reviewSet.targetBranch, fresh },
      (repo, value) => phase(repo.connectionId, repo.repo, repo.position, value),
    );
    const repos = await mapLimit(located, 4, async ({ status, sha }) => {
      const client = clients.get(status.connectionId);
      if (!status.branch || !sha || !client) {
        options.onRepo?.(status);
        return status;
      }
      const knownPull = reviewSetPullRequest(reviewSet.id, status.connectionId, status.repo, status.position);
      const result = await inspectBranch(client, status, sha, fresh, includeCommits, knownPull, (value) =>
        phase(status.connectionId, status.repo, status.position, value),
      );
      options.onRepo?.(result);
      return result;
    });

    for (const repo of repos) {
      const error = repo.error ?? multiMatchError(repo);
      if (error) errors.push(error);
    }

    const openRepos = repos.filter((repo) => repo.state === 'open');
    const matchedOk = repos.filter((repo) => repo.branch && repo.state !== 'error');
    const hasRepoErrors = repos.some((repo) => repo.state === 'error');

    // Stacks can be read layer by layer or as one cumulative diff from the
    // target branch to the top of the stack.
    const combined = stacked ? await combinedStacks(clients, repos, reviewSet, fresh) : undefined;

    const hasOpen = openRepos.length > 0;
    const lifecycle = hasOpen ? ensurePrLifecycle(reviewSet.id, true) : hasRepoErrors ? null : ensurePrLifecycle(reviewSet.id, false);

    const stats = openRepos.reduce(
      (acc, repo) => ({
        repos: acc.repos + 1,
        files: acc.files + (repo.files?.length ?? 0),
        additions: acc.additions + (repo.additions ?? 0),
        deletions: acc.deletions + (repo.deletions ?? 0),
      }),
      zeroStats(),
    );

    const empty = { comments: [], reviewed: [], reviewedBy: [], prId: null, stats: zeroStats() };
    if (hasOpen && lifecycle) {
      if (lifecycle.prId && ensurePulls) await ensureRepoPullRequests(clients, reviewSet, repos, lifecycle.prId);
      else attachKnownPullRequests(clients, repos, lifecycle.prId);
      await mapLimit(repos, 4, async (repo) => {
        const client = clients.get(repo.connectionId);
        if (!repo.pullRequest || !client) return;
        const ref = repo.pullRequest.ref;
        try {
          const state = await client.pullRequestState?.(repo.repo, ref);
          if (state) {
            repo.pullRequest = { ...repo.pullRequest, state: state.state, head: state.head, base: state.base };
            const notes: string[] = [];
            if (state.state === 'closed') notes.push('the pull request was closed on the forge');
            if (state.head && repo.branch && state.head !== repo.branch) {
              notes.push(`the pull request now points at ${state.head} instead of ${repo.branch}`);
            }
            const target = repo.target || reviewSet.targetBranch;
            if (state.base && target && state.base !== target) {
              notes.push(`the pull request now targets ${state.base} instead of ${target}`);
            }
            if (notes.length > 0) repo.note = [repo.note, `${notes.join('; ')}.`].filter(Boolean).join(' ');
          }
        } catch (error) {
          console.error(`Could not read the pull request state for ${repoLabel(repo)}:`, error);
        }
        if (!client.pullRequestReview) return;
        try {
          repo.pullRequest = { ...repo.pullRequest, review: await client.pullRequestReview(repo.repo, ref) };
        } catch (error) {
          console.error(`Could not read the review state for ${repoLabel(repo)}:`, error);
        }
        if (client.pullRequestReviews) {
          try {
            repo.pullRequest = { ...repo.pullRequest, reviewers: await client.pullRequestReviews(repo.repo, ref) };
          } catch (error) {
            console.error(`Could not read the reviewers for ${repoLabel(repo)}:`, error);
          }
        }
      });
      if (options.headSync && lifecycle.prId) await resetMarksForNewCommits(clients, repos, lifecycle.prId);
      return {
        state: 'open',
        errors,
        repos,
        combined,
        prId: lifecycle.prId,
        comments: includeDiscussions && lifecycle.prId ? listComments(lifecycle.prId) : [],
        reviewed: includeDiscussions && lifecycle.prId && options.viewerId ? listReviewed(lifecycle.prId, options.viewerId) : [],
        reviewedBy: includeDiscussions && lifecycle.prId ? listReviewedBy(lifecycle.prId) : [],
        stats,
      };
    }
    if (matchedOk.length > 0) return { state: 'closed', errors, repos, combined, ...empty };
    if (errors.length > 0) return { state: 'invalid', errors, repos, combined, ...empty };
    return { state: 'empty', errors, repos, combined, ...empty };
  } finally {
    if (reporting) finishRun(reviewSet.id);
  }
}

/**
 * The cumulative diff of every stack: the review set's target branch against
 * the top layer's head. Entries carry position -1 so nothing treats them as a
 * layer (comments, pull requests and merging skip them).
 */
async function combinedStacks(
  clients: Map<number, ForgeClient>,
  repos: RepoStatus[],
  reviewSet: ReviewSet,
  fresh: boolean,
): Promise<RepoStatus[]> {
  const stacks = new Map<string, RepoStatus[]>();
  for (const repo of repos) {
    if (!repo.branch || !repo.headSha || repo.state === 'error') continue;
    const key = `${repo.connectionId}:${repo.repo}`;
    const group = stacks.get(key) ?? [];
    group.push(repo);
    stacks.set(key, group);
  }

  const combined: RepoStatus[] = [];
  await mapLimit([...stacks.values()], 4, async (layers) => {
    const ordered = [...layers].sort((a, b) => a.position - b.position);
    const top = ordered[ordered.length - 1];
    const client = clients.get(top.connectionId);
    if (!client) return;
    try {
      const targetRef = await client.getBranch(top.repo, reviewSet.targetBranch, { fresh });
      if (!targetRef) return;
      const comparison = await client.compare(top.repo, targetRef.sha, top.headSha!);
      const files = comparison.files.map(toFileDiff);
      const totals = summarize(files);
      combined.push({
        ...top,
        position: -1,
        target: reviewSet.targetBranch,
        targetExists: true,
        state: comparison.merged ? 'merged' : 'open',
        aheadBy: comparison.aheadBy,
        behindBy: comparison.behindBy,
        additions: totals.additions,
        deletions: totals.deletions,
        truncated: comparison.truncated,
        files,
        commits: comparison.commits,
      });
    } catch (error) {
      console.error(`Could not build the combined diff for ${top.repo}:`, error);
    }
  });
  return combined;
}
