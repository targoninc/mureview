import { nothingToMerge, type ConflictState, type MergePreview, type MergePreviewRepo, type PrStatus, type RepoStatus, type ReviewSet } from '../shared/types';
import { Cache, mapLimit } from './cache';
import { constants } from './config';
import type { ForgeConnectionRow } from './db';
import { type ForgeClient } from './forges';
import { hasConflict } from './conflicts';
import { actingPermission } from './permissions';
import { buildPrStatus, clientsFor } from './pr';
import { forgeErrorMessage } from './validate';

const maxCheckedFiles = 40;
const recentStatus = new Cache<PrStatus>(50, 60_000);

export function recentMergeStatus(reviewSetId: number): PrStatus | undefined {
  return recentStatus.get(String(reviewSetId));
}

export function forgetMergeStatus(reviewSetId: number): void {
  recentStatus.delete(String(reviewSetId));
}

type Blob =
  | { status: 'missing' }
  | { status: 'skipped' }
  | { status: 'binary' }
  | { status: 'text'; content: string };

async function blobAt(client: ForgeClient, repo: string, ref: string, path: string): Promise<Blob> {
  const listing = await client.listBlobs(repo, ref);
  const blob = listing.blobs.find((entry) => entry.path === path);
  if (!blob) return { status: 'missing' };
  if (blob.size > constants.maxFileBytes) return { status: 'skipped' };
  const content = await client.getBlobText(repo, blob.sha);
  return content === null ? { status: 'binary' } : { status: 'text', content };
}

function fileConflicts(base: Blob, ours: Blob, theirs: Blob): 'conflict' | 'clean' | 'unknown' {
  if (ours.status === 'missing' && theirs.status === 'missing') return 'clean';
  if (ours.status === 'missing' || theirs.status === 'missing') return 'conflict'; // delete/modify
  if (ours.status === 'skipped' || theirs.status === 'skipped' || base.status === 'skipped') return 'unknown';
  if (ours.status === 'binary' || theirs.status === 'binary' || base.status === 'binary') return 'conflict';
  if (base.status === 'missing') return ours.content === theirs.content ? 'clean' : 'conflict'; // add/add
  return hasConflict(base.content, ours.content, theirs.content) ? 'conflict' : 'clean';
}

async function checkRepo(
  client: ForgeClient,
  base: MergePreviewRepo,
  headSha: string,
  targetSha: string,
  knownMergeBase?: string,
): Promise<MergePreviewRepo> {
  const mergeBase = knownMergeBase ?? (await client.mergeBase(base.repo, targetSha, headSha));
  if (!mergeBase) return { ...base, conflicts: 'unknown' };
  if (mergeBase === targetSha) return base; // fast-forward, nothing to conflict with

  const [ours, theirs] = await Promise.all([client.compare(base.repo, mergeBase, headSha), client.compare(base.repo, mergeBase, targetSha)]);
  const targetPaths = new Set(theirs.files.map((file) => file.path));
  const shared = ours.files.filter((file) => targetPaths.has(file.path));
  if (!shared.length) return base;

  const conflictFiles: string[] = [];
  let unchecked = 0;
  const toCheck = shared.slice(0, maxCheckedFiles);
  unchecked += shared.length - toCheck.length;

  for (const file of toCheck) {
    const [baseBlob, ourBlob, theirBlob] = await Promise.all([
      blobAt(client, base.repo, mergeBase, file.prevPath ?? file.path),
      blobAt(client, base.repo, headSha, file.path),
      blobAt(client, base.repo, targetSha, file.path),
    ]);
    const verdict = fileConflicts(baseBlob, ourBlob, theirBlob);
    if (verdict === 'conflict') conflictFiles.push(file.path);
    else if (verdict === 'unknown') unchecked++;
  }

  const conflicts: ConflictState = conflictFiles.length > 0 ? 'detected' : unchecked > 0 ? 'unknown' : 'none';
  return { ...base, conflicts, conflictFiles, checkedFiles: toCheck.length, uncheckedFiles: unchecked };
}

async function previewRepo(client: ForgeClient | undefined, repo: RepoStatus, target: string): Promise<MergePreviewRepo> {
  const base: MergePreviewRepo = {
    connectionId: repo.connectionId,
    kind: repo.kind,
    host: repo.host,
    repo: repo.repo,
    position: repo.position,
    branch: repo.branch!,
    target,
    targetExists: repo.targetExists,
    aheadBy: repo.aheadBy ?? 0,
    behindBy: repo.behindBy ?? 0,
    files: repo.files?.length ?? 0,
    additions: repo.additions ?? 0,
    deletions: repo.deletions ?? 0,
    truncated: repo.truncated ?? false,
    conflicts: 'none',
    conflictFiles: [],
    checkedFiles: 0,
    uncheckedFiles: 0,
    canComplete: 'unknown',
    checks: { state: 'none', runs: [] },
    pullRequest: repo.pullRequest,
  };
  if (!client) return { ...base, conflicts: 'unknown', checks: { state: 'unknown', runs: [] }, error: 'the forge connection was removed' };
  try {
    if (client.pullRequestPermission || client.ownPermission) {
      const permission = await actingPermission(client, repo.repo);
      base.canComplete = permission === 'write' ? 'yes' : permission === 'read' ? 'no' : 'unknown';
    }
    const headSha = repo.headSha;
    if (!headSha) return base;
    base.checks = await client.checks(repo.repo, headSha, { pullRequest: repo.pullRequest?.ref });
    if (!repo.targetExists) return base; // the target branch is created from the source, no conflicts possible
    const pull = base.pullRequest;
    if (
      repo.position === 0 &&
      pull?.state !== 'closed' &&
      pull?.state !== 'merged' &&
      pull?.mergeable !== undefined &&
      pull?.mergeable !== null &&
      (!pull.base || pull.base === target)
    ) {
      return { ...base, conflicts: pull.mergeable ? 'none' : 'detected' };
    }
    let targetSha = repo.targetSha;
    if (!targetSha) {
      const targetRef = await client.getBranch(repo.repo, target, {});
      targetSha = targetRef?.sha;
    }
    if (!targetSha) return base;
    return await checkRepo(client, base, headSha, targetSha, repo.mergeBase);
  } catch (error) {
    return { ...base, conflicts: 'unknown', error: forgeErrorMessage(error) };
  }
}

export interface MergePreviewOptions {
  /** Report the loading status of the review set itself while it loads. */
  progressUserId?: number;
  /** Whose viewed marks to include while inspecting the review set. */
  viewerId?: number;
  /** Act with these clients (keyed like the review set's connections). */
  clients?: Map<number, ForgeClient>;
  /** Called with every repository's status as the review set is inspected. */
  onStatus?: (repo: RepoStatus) => void;
  /** The number of repositories that will be checked for conflicts. */
  onStart?: (total: number) => void;
  /** Called as soon as a repository's preview card is ready. */
  onRepo?: (repo: MergePreviewRepo) => void;
}

export async function buildMergePreview(
  connections: ForgeConnectionRow[],
  reviewSet: ReviewSet,
  options: MergePreviewOptions = {},
): Promise<MergePreview> {
  const status = await buildPrStatus(connections, reviewSet, false, {
    commits: false,
    progress: options.progressUserId !== undefined,
    progressUserId: options.progressUserId,
    viewerId: options.viewerId,
    clients: options.clients,
    onRepo: options.onStatus,
  });
  const clients = options.clients ?? clientsFor(connections);

  // Only repositories with something to merge get a preview card; the rest
  // (no matching branch, already merged, no changes) are summarized instead.
  const open = status.repos.filter((repo) => repo.state === 'open' && repo.branch && nothingToMerge(repo) === null);
  options.onStart?.(open.length);
  const repos = await mapLimit(open, 3, async (repo): Promise<MergePreviewRepo> => {
    const card = await previewRepo(clients.get(repo.connectionId), repo, repo.target || reviewSet.targetBranch);
    options.onRepo?.(card);
    return card;
  });

  recentStatus.set(String(reviewSet.id), status);
  return {
    target: reviewSet.targetBranch,
    repos,
    // Merging happens per repository and per layer, so a blocked layer does
    // not have to block the layers that can land.
    canMerge: repos.some(
      (repo) => !repo.error && repo.conflicts !== 'detected' && repo.checks.state !== 'failure' && repo.canComplete !== 'no',
    ),
  };
}
