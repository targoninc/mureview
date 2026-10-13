import type { ConflictState, MergePreview, MergePreviewRepo, RepoStatus, ReviewSet } from '../shared/types';
import { mapLimit } from './cache';
import { constants } from './config';
import type { ForgeConnectionRow } from './db';
import { type ForgeClient } from './forges';
import { hasConflict } from './conflicts';
import { buildPrStatus, clientsFor } from './pr';
import { forgeErrorMessage } from './validate';

const maxCheckedFiles = 40;

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

async function checkRepo(client: ForgeClient, base: MergePreviewRepo, headSha: string, targetSha: string): Promise<MergePreviewRepo> {
  const mergeBase = await client.mergeBase(base.repo, targetSha, headSha);
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
    if (client.pullRequestPermission) {
      const permission = await client.pullRequestPermission(repo.repo);
      base.canComplete = permission === 'write' ? 'yes' : permission === 'read' ? 'no' : 'unknown';
    }
    const headRef = await client.getBranch(repo.repo, repo.branch!, { fresh: true });
    if (!headRef) return base;
    base.checks = await client.checks(repo.repo, headRef.sha, { pullRequest: repo.pullRequest?.ref });
    if (!repo.targetExists) return base; // the target branch is created from the source, no conflicts possible
    const targetRef = await client.getBranch(repo.repo, target, { fresh: true });
    if (!targetRef) return base;
    return await checkRepo(client, base, headRef.sha, targetRef.sha);
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
  const status = await buildPrStatus(connections, reviewSet, true, {
    commits: false,
    progress: options.progressUserId !== undefined,
    progressUserId: options.progressUserId,
    viewerId: options.viewerId,
    clients: options.clients,
    onRepo: options.onStatus,
  });
  const clients = options.clients ?? clientsFor(connections);

  const open = status.repos.filter((repo) => repo.state === 'open' && repo.branch);
  options.onStart?.(open.length);
  const repos = await mapLimit(open, 3, async (repo): Promise<MergePreviewRepo> => {
    const card = await previewRepo(clients.get(repo.connectionId), repo, repo.target || reviewSet.targetBranch);
    options.onRepo?.(card);
    return card;
  });

  return {
    target: reviewSet.targetBranch,
    repos,
    canMerge:
      repos.length > 0 &&
      repos.every(
        (repo) => !repo.error && repo.conflicts !== 'detected' && repo.checks.state !== 'failure' && repo.canComplete !== 'no',
      ),
  };
}
