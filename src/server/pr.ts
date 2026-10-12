import type { FileDiff, FileStatus, PrStatus, RepoStatus, ReviewSet } from '../shared/types';
import { constants } from './config';
import { db } from './db';
import { listComments } from './comments';
import { GitHubError, type GithubCompareFile, compareBranches, getBlobText, getBranch, getTree } from './github';
import { addedFilePatch, countLines } from './patch';
import { compileRegex, githubErrorMessage, inspectRepos, multiMatchError } from './validate';

const zeroStats = () => ({ repos: 0, files: 0, additions: 0, deletions: 0 });

const statusMap: Record<string, FileStatus> = {
  added: 'added',
  removed: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};

function toFileDiff(file: GithubCompareFile): FileDiff {
  return {
    path: file.filename,
    prevPath: file.previous_filename,
    type: statusMap[file.status] ?? 'modified',
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
  };
}

function summarize(files: FileDiff[]): { additions: number; deletions: number } {
  return files.reduce((acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }), {
    additions: 0,
    deletions: 0,
  });
}

async function targetlessDiff(token: string, repo: string, branch: string): Promise<{ files: FileDiff[]; additions: number; truncated: boolean }> {
  const branchInfo = await getBranch(token, repo, branch);
  const tree = await getTree(token, repo, branchInfo.commit.sha);
  const blobs = tree.tree.filter((entry) => entry.type === 'blob' && (entry.size ?? 0) <= constants.maxFileBytes);
  const capped = blobs.slice(0, constants.maxRepoFiles);
  const files: FileDiff[] = [];

  for (let i = 0; i < capped.length; i += 5) {
    const batch = capped.slice(i, i + 5);
    const loaded = await Promise.all(
      batch.map(async (entry) => {
        const content = await getBlobText(token, repo, entry.sha);
        if (content === null) return null;
        return {
          path: entry.path,
          type: 'added' as const,
          additions: countLines(content),
          deletions: 0,
          patch: addedFilePatch(entry.path, content),
        } satisfies FileDiff;
      }),
    );
    for (const file of loaded) if (file) files.push(file);
  }

  return { files, additions: summarize(files).additions, truncated: tree.truncated || capped.length < blobs.length };
}

async function inspectBranch(token: string, status: RepoStatus, target: string): Promise<RepoStatus> {
  const repo = status.repo;
  const branch = status.branch!;
  try {
    let targetExists = true;
    try {
      await getBranch(token, repo, target);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) targetExists = false;
      else throw error;
    }

    if (!targetExists) {
      const diff = await targetlessDiff(token, repo, branch);
      return { ...status, targetExists, state: 'open', aheadBy: diff.files.length, additions: diff.additions, deletions: 0, truncated: diff.truncated, files: diff.files };
    }

    const comparison = await compareBranches(token, repo, target, branch);
    if (comparison.status === 'behind' || comparison.status === 'identical') {
      return { ...status, targetExists, state: 'merged', aheadBy: comparison.ahead_by, behindBy: comparison.behind_by };
    }

    const files = (comparison.files ?? []).map(toFileDiff);
    const totals = summarize(files);
    return {
      ...status,
      targetExists,
      state: 'open',
      aheadBy: comparison.ahead_by,
      behindBy: comparison.behind_by,
      additions: totals.additions,
      deletions: totals.deletions,
      truncated: files.length >= constants.maxRepoFiles,
      files,
    };
  } catch (error) {
    return { ...status, error: `Could not build the diff for ${repo} (${githubErrorMessage(error)}).`, state: 'error' };
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
    return { prId: null, justClosed: true };
  }
  return { prId: null, justClosed: false };
}

export async function buildPrStatus(token: string, reviewSet: ReviewSet): Promise<PrStatus> {
  const errors: string[] = [];
  const regex = compileRegex(reviewSet.branchRegex);
  if (!regex) errors.push('The branch pattern is not a valid regular expression.');

  const statuses = await inspectRepos(token, reviewSet.repos, regex);
  const repos: RepoStatus[] = [];
  for (const status of statuses) {
    repos.push(status.branch ? await inspectBranch(token, status, reviewSet.targetBranch) : status);
  }

  for (const repo of repos) {
    const error = repo.error ?? multiMatchError(repo);
    if (error) errors.push(error);
  }

  const openRepos = repos.filter((repo) => repo.state === 'open');
  const matchedOk = repos.filter((repo) => repo.branch && repo.state !== 'error');
  const hasRepoErrors = repos.some((repo) => repo.state === 'error');

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

  if (hasOpen && lifecycle) {
    return { state: 'open', errors, repos, prId: lifecycle.prId, comments: lifecycle.prId ? listComments(lifecycle.prId) : [], stats };
  }
  if (matchedOk.length > 0) {
    return { state: 'closed', errors, repos, prId: null, comments: [], stats: zeroStats() };
  }
  if (errors.length > 0) {
    return { state: 'invalid', errors, repos, prId: null, comments: [], stats: zeroStats() };
  }
  return { state: 'empty', errors, repos, prId: null, comments: [], stats: zeroStats() };
}
