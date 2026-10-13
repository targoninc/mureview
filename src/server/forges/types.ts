import type { CheckInfo, ChecksSummary, CommitInfo, FileStatus, ForgeKind } from '../../shared/types';

export type { CheckInfo, ChecksSummary, CommitInfo };

export interface ForgeComment {
  id: string;
  author: { name: string; avatarUrl: string };
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  side?: 'additions' | 'deletions';
  replyToId?: string;
}

export class ForgeError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ForgeRepo {
  repo: string;
  private: boolean;
  updatedAt?: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
}

export interface CompareFile {
  path: string;
  prevPath?: string;
  type: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface CompareResult {
  merged: boolean;
  aheadBy: number;
  behindBy: number;
  files: CompareFile[];
  commits: CommitInfo[];
  truncated: boolean;
}

export interface TreeBlob {
  path: string;
  sha: string;
  size: number;
}

export interface TreeListing {
  blobs: TreeBlob[];
  truncated: boolean;
}

export interface ForgeCallOptions {
  fresh?: boolean;
}

export interface PullRequestRef {
  number: number;
  created: boolean;
}

export interface ReviewComment {
  body: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
  commitId?: string;
  /** Forge id of the comment being answered, to continue its thread. */
  replyTo?: string;
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  readonly baseUrl: string;
  readonly host: string;
  listRepos(): Promise<ForgeRepo[]>;
  ensureRepo(repo: string, options?: ForgeCallOptions): Promise<void>;
  listBranches(repo: string, options?: ForgeCallOptions): Promise<BranchInfo[]>;
  getBranch(repo: string, branch: string, options?: ForgeCallOptions): Promise<BranchInfo | null>;
  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult>;
  mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null>;
  listBlobs(repo: string, sha: string): Promise<TreeListing>;
  getBlobText(repo: string, sha: string): Promise<string | null>;
  ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string): Promise<PullRequestRef>;
  mergePullRequest(repo: string, number: number, message: string): Promise<string>;
  pullRequestUrl(repo: string, number: number): string;
  postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<{ kind: 'line' | 'pull-request'; id?: string }>;
  listComments(repo: string, number: number): Promise<ForgeComment[]>;
  fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null>;
  listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number }): Promise<CommitInfo[]>;
  checks(repo: string, sha: string, options?: { pullRequest?: number }): Promise<ChecksSummary>;
  createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void>;
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** Azure DevOps organizations (and similar path-scoped forges) live in the path. */
export function organizationOf(baseUrl: string): string | null {
  const path = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, '');
  return path || null;
}

export const statusMap: Record<string, FileStatus> = {
  added: 'added',
  removed: 'deleted',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};

export function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

const maxAvatarBytes = 2_000_000;

/** Fetches an image, with optional forge credentials, for the avatar proxy. */
export async function fetchImage(url: string, headers?: HeadersInit): Promise<{ contentType: string; body: Buffer } | null> {
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) return null;
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length || body.length > maxAvatarBytes) return null;
  return { contentType, body };
}

export function summarizeChecks(runs: CheckInfo[]): ChecksSummary['state'] {
  if (!runs.length) return 'none';
  if (runs.some((run) => run.state === 'failure')) return 'failure';
  if (runs.some((run) => run.state === 'pending' || run.state === 'unknown')) return 'pending';
  return 'success';
}
