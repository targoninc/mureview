import type { CommitInfo, FileStatus } from '../shared/types';
import { Cache } from './cache';
import { db } from './db';
import type { CompareFile, CompareResult, ForgeClient } from './forges';
import { addedFilePatch, deletedFilePatch, modifiedFilePatch, patchStats } from './patch';

const version = 1;
const maxCachedCommits = 300;

interface StoredComparison extends CompareResult {
  base: string;
  head: string;
}

export interface CachedComparison {
  comparison: CompareResult;
  commits: CommitInfo[];
}

function rowFor(connectionId: number, repo: string, baseSha: string): { head_sha: string; result: string; commits: string } | null {
  return (
    db
      .query<{ head_sha: string; result: string; commits: string }, [number, number, string, string]>(
        'SELECT head_sha, result, commits FROM diff_cache WHERE version = ? AND connection_id = ? AND repo = ? AND base_sha = ?',
      )
      .get(version, connectionId, repo, baseSha) ?? null
  );
}

function read(connectionId: number, repo: string, baseSha: string): CachedComparison | null {
  const row = rowFor(connectionId, repo, baseSha);
  if (!row) return null;
  try {
    return { comparison: JSON.parse(row.result) as StoredComparison, commits: JSON.parse(row.commits) as CommitInfo[] };
  } catch {
    return null;
  }
}

function write(connectionId: number, repo: string, comparison: StoredComparison, commits: CommitInfo[]): void {
  try {
    db.run(
      `INSERT INTO diff_cache (version, connection_id, repo, base_sha, head_sha, result, commits, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(version, connection_id, repo, base_sha)
       DO UPDATE SET head_sha = excluded.head_sha, result = excluded.result, commits = excluded.commits, updated_at = datetime('now')`,
      [version, connectionId, repo, comparison.base, comparison.head, JSON.stringify(comparison), JSON.stringify(commits)],
    );
    db.run("DELETE FROM diff_cache WHERE version <> ? OR updated_at < datetime('now', '-30 days')", [version]);
  } catch (error) {
    console.error('Could not cache the diff:', error);
  }
}

function withRevisions(comparison: CompareResult, baseSha: string, headSha: string): StoredComparison {
  return { ...comparison, base: baseSha, head: headSha };
}

function combineCommits(old: CommitInfo[], delta: CommitInfo[]): CommitInfo[] {
  const bySha = new Map<string, CommitInfo>();
  for (const commit of [...old, ...delta]) bySha.set(commit.sha, commit);
  return [...bySha.values()]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, maxCachedCommits);
}

function typeFor(cached: CompareFile | undefined, delta: CompareFile, hasBase: boolean, hasHead: boolean): FileStatus {
  if (!hasBase && hasHead) return 'added';
  if (hasBase && !hasHead) return 'deleted';
  if (cached?.type === 'renamed' || delta.type === 'renamed') return 'renamed';
  if (cached?.type === 'copied' || delta.type === 'copied') return 'copied';
  return 'modified';
}

/**
 * Recomputes only the files that changed since the cached head. Unchanged
 * files keep their cached patches, so a new commit does not refetch the whole
 * branch comparison.
 */
async function mergeFiles(
  client: ForgeClient,
  repo: string,
  baseSha: string,
  headSha: string,
  cachedFiles: CompareFile[],
  deltaFiles: CompareFile[],
): Promise<CompareFile[] | null> {
  const byPath = new Map(cachedFiles.map((file) => [file.path, file]));
  const needsTrees = deltaFiles.some(
    (file) => byPath.has(file.path) || (file.prevPath ? byPath.has(file.prevPath) : false),
  );
  if (!needsTrees) {
    // Every changed path was untouched by the earlier commits, so the forge's
    // delta patch is already the cumulative patch against the base.
    for (const delta of deltaFiles) {
      byPath.delete(delta.path);
      if (delta.prevPath) byPath.delete(delta.prevPath);
      byPath.set(delta.path, { ...delta });
    }
    return [...byPath.values()];
  }

  let baseTree;
  let headTree;
  try {
    [baseTree, headTree] = await Promise.all([client.listBlobs(repo, baseSha), client.listBlobs(repo, headSha)]);
  } catch {
    return null;
  }
  if (baseTree.truncated || headTree.truncated) return null;

  const baseBlobs = new Map(baseTree.blobs.map((blob) => [blob.path, blob]));
  const headBlobs = new Map(headTree.blobs.map((blob) => [blob.path, blob]));

  for (const delta of deltaFiles) {
    const cached = byPath.get(delta.path) ?? (delta.prevPath ? byPath.get(delta.prevPath) : undefined);
    const headBlob = headBlobs.get(delta.path);
    const prevPath = (cached?.type === 'renamed' || cached?.type === 'copied' ? cached.prevPath : undefined) ?? delta.prevPath;
    const basePath = prevPath ?? delta.path;
    const baseBlob = baseBlobs.get(basePath);

    byPath.delete(delta.path);
    if (delta.prevPath) byPath.delete(delta.prevPath);

    if (!baseBlob && !headBlob) {
      if (cached?.type === 'added' && delta.type === 'deleted') continue;
      byPath.set(delta.path, {
        ...(cached ?? delta),
        path: delta.path,
        type: cached?.type === 'added' ? 'added' : delta.type,
        patch: null,
        additions: 0,
        deletions: 0,
      });
      continue;
    }

    const type = typeFor(cached, delta, Boolean(baseBlob), Boolean(headBlob));
    let patch: string | null = null;
    if (baseBlob && headBlob) {
      const [oldContent, newContent] = await Promise.all([
        client.getBlobText(repo, baseBlob.sha),
        client.getBlobText(repo, headBlob.sha),
      ]);
      if (oldContent !== null && newContent !== null) {
        if (oldContent === newContent && type === 'modified' && delta.additions + delta.deletions > 0) {
          // The branch changed this file and changed it back; it is no longer
          // part of the cumulative diff.
          continue;
        }
        patch = modifiedFilePatch(
          { path: delta.path, prevPath: type === 'renamed' || type === 'copied' ? prevPath : undefined, type },
          oldContent,
          newContent,
        );
      }
    } else if (headBlob) {
      const content = await client.getBlobText(repo, headBlob.sha);
      if (content !== null) patch = addedFilePatch(delta.path, content);
    } else if (baseBlob) {
      const content = await client.getBlobText(repo, baseBlob.sha);
      if (content !== null) patch = deletedFilePatch(prevPath ?? delta.path, content);
    }

    const stats = patch === null ? { additions: 0, deletions: 0 } : patchStats(patch);
    const path = type === 'deleted' ? (prevPath ?? delta.path) : delta.path;
    byPath.set(path, {
      path,
      prevPath: type === 'renamed' || type === 'copied' ? prevPath : undefined,
      type,
      additions: stats.additions,
      deletions: stats.deletions,
      patch,
    });
  }

  return [...byPath.values()];
}

/** Stores a complete commit list fetched separately from the comparison. */
export function rememberCommits(
  connectionId: number,
  repo: string,
  baseSha: string,
  headSha: string,
  commits: CommitInfo[],
): void {
  const row = rowFor(connectionId, repo, baseSha);
  if (!row) return;
  try {
    const stored = JSON.parse(row.result) as StoredComparison;
    if (stored.head !== headSha) return;
    const remembered = memory.get(`${connectionId}:${repo}:${baseSha}`);
    if (remembered) memory.set(`${connectionId}:${repo}:${baseSha}`, { comparison: remembered.comparison, commits });
    db.run(
      'UPDATE diff_cache SET commits = ?, updated_at = datetime(\'now\') WHERE version = ? AND connection_id = ? AND repo = ? AND base_sha = ?',
      [JSON.stringify(commits), version, connectionId, repo, baseSha],
    );
  } catch {
    // A malformed cache row is ignored and will be replaced on the next load.
  }
}

const memory = new Cache<CachedComparison>(200, 5 * 60_000);
const inflight = new Map<string, Promise<CachedComparison>>();

/**
 * A comparison cache keyed by the base and head revisions. When only the head
 * advances, the forge comparison from the previous head to the new one is
 * merged into the cached file list and commit list.
 */
export function cachedCompare(
  client: ForgeClient,
  connectionId: number,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<CachedComparison> {
  const memoryKey = `${connectionId}:${repo}:${baseSha}`;
  const remembered = memory.get(memoryKey);
  if (remembered && (remembered.comparison as StoredComparison).head === headSha) return Promise.resolve(remembered);

  const key = `${connectionId}:${repo}:${baseSha}:${headSha}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const cached = read(connectionId, repo, baseSha);
    const stored = cached?.comparison as StoredComparison | undefined;
    if (cached && stored?.base === baseSha && stored.head === headSha) {
      memory.set(memoryKey, cached);
      return cached;
    }

    // Forgejo's merge-base lookup walks commit parents one request at a time;
    // a full comparison is cheaper there unless the server reports it.
    const baseIsAncestor = cached
      ? cached.comparison.mergeBase !== undefined
        ? cached.comparison.mergeBase === baseSha
        : cached.comparison.behindBy === 0
      : false;
    if (
      cached &&
      stored &&
      stored.base === baseSha &&
      client.kind !== 'forgejo' &&
      baseIsAncestor &&
      !cached.comparison.merged &&
      !cached.comparison.truncated
    ) {
      const delta = await client.compare(repo, stored.head, headSha);
      const mergeBase = delta.mergeBase ?? (await client.mergeBase(repo, stored.head, headSha).catch(() => null));
      if (!delta.truncated && !delta.merged && delta.behindBy === 0 && mergeBase === stored.head) {
        const files =
          delta.files.length === 0
            ? cached.comparison.files
            : await mergeFiles(client, repo, baseSha, headSha, cached.comparison.files, delta.files);
        if (files) {
          const commits = combineCommits(cached.commits, delta.commits);
          const comparison = withRevisions(
            {
              ...cached.comparison,
              aheadBy: cached.comparison.aheadBy + delta.aheadBy,
              files,
              commits,
              truncated: cached.comparison.truncated || delta.truncated,
              mergeBase: cached.comparison.mergeBase ?? delta.mergeBase,
            },
            baseSha,
            headSha,
          );
          write(connectionId, repo, comparison, commits);
          const result = { comparison, commits };
          memory.set(memoryKey, result);
          return result;
        }
      }
    }

    const comparison = withRevisions(await client.compare(repo, baseSha, headSha), baseSha, headSha);
    write(connectionId, repo, comparison, comparison.commits);
    const result = { comparison, commits: comparison.commits };
    memory.set(memoryKey, result);
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}
