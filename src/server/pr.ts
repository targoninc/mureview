import type { FileDiff, FileStatus, PrStatus, RepoStatus, ReviewSet } from '../shared/types';
import { Cache, cached, mapLimit } from './cache';
import { listComments } from './comments';
import { constants } from './config';
import { db } from './db';
import { type GithubCompareFile, compareCached, getBlobTextCached, getBranchCached, getTreeCached } from './github';
import { addedFilePatch, countLines, withPatchHeader } from './patch';
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

interface BranchDiff {
  files: FileDiff[];
  additions: number;
  truncated: boolean;
}

const targetlessCache = new Cache<BranchDiff>(30, 60 * 60_000);

function toFileDiff(file: GithubCompareFile): FileDiff {
  // GitHub's compare API returns hunk-only patches; add the git headers so the
  // diff renderer knows the file name.
  const diff: FileDiff = {
    path: file.filename,
    prevPath: file.previous_filename,
    type: statusMap[file.status] ?? 'modified',
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
  };
  if (diff.patch !== null) diff.patch = withPatchHeader(diff);
  return diff;
}

function summarize(files: FileDiff[]): { additions: number; deletions: number } {
  return files.reduce((acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }), {
    additions: 0,
    deletions: 0,
  });
}

function targetlessDiff(token: string, repo: string, branchSha: string): Promise<BranchDiff> {
  return cached(targetlessCache, `${repo}#${branchSha}`, async () => {
    const tree = await getTreeCached(token, repo, branchSha);
    const blobs = tree.tree.filter((entry) => entry.type === 'blob' && (entry.size ?? 0) <= constants.maxFileBytes);
    const capped = blobs.slice(0, constants.maxRepoFiles);
    const loaded = await mapLimit(capped, 10, async (entry): Promise<FileDiff | null> => {
      const content = await getBlobTextCached(token, repo, entry.sha);
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

async function inspectBranch(token: string, status: RepoStatus, branchSha: string, target: string, fresh: boolean): Promise<RepoStatus> {
  const repo = status.repo;
  try {
    const targetRef = await getBranchCached(token, repo, target, fresh);
    if (!targetRef) {
      const diff = await targetlessDiff(token, repo, branchSha);
      return {
        ...status,
        targetExists: false,
        state: 'open',
        aheadBy: diff.files.length,
        additions: diff.additions,
        deletions: 0,
        truncated: diff.truncated,
        files: diff.files,
      };
    }

    const comparison = await compareCached(token, repo, targetRef.commit.sha, branchSha);
    if (comparison.status === 'behind' || comparison.status === 'identical') {
      return { ...status, targetExists: true, state: 'merged', aheadBy: comparison.ahead_by, behindBy: comparison.behind_by };
    }

    const files = (comparison.files ?? []).map(toFileDiff);
    const totals = summarize(files);
    return {
      ...status,
      targetExists: true,
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

export async function buildPrStatus(token: string, reviewSet: ReviewSet, fresh = false): Promise<PrStatus> {
  const errors: string[] = [];
  const regex = compileRegex(reviewSet.branchRegex);
  if (!regex) errors.push('The branch pattern is not a valid regular expression.');

  const located = await inspectRepos(token, reviewSet.repos, regex, fresh);
  const repos = await mapLimit(located, 4, async ({ status, sha }) =>
    status.branch && sha ? inspectBranch(token, status, sha, reviewSet.targetBranch, fresh) : status,
  );

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
