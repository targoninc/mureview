import type { CheckInfo, ChecksSummary, CommitInfo, FileStatus, ForgeKind, RefInfo } from '../../shared/types';

export type { CheckInfo, ChecksSummary, CommitInfo, RefInfo };

export interface ForgeComment {
  id: string;
  author: { name: string; avatarUrl: string };
  body: string;
  createdAt: string;
  path?: string;
  line?: number;
  side?: 'additions' | 'deletions';
  replyToId?: string;
  /** Whether the comment's thread is resolved on the forge. */
  resolved?: boolean;
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

/** The description line that points back at mureview. */
export function mureviewLink(url: string): string {
  return `Open in mureview: ${url}`;
}

/** The description to create a pull request with. */
export function withMureviewLink(body: string, url?: string): string {
  const text = body.trim();
  if (!url || text.includes(url)) return text;
  return text ? `${text}\n\n${mureviewLink(url)}` : mureviewLink(url);
}

/** The description with the mureview link appended, or null when it is already there. */
export function appendMureviewLink(body: string | null | undefined, url: string): string | null {
  const text = (body ?? '').trim();
  if (text.includes(url)) return null;
  return text ? `${text}\n\n${mureviewLink(url)}` : mureviewLink(url);
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

export interface PostedComment {
  kind: 'line' | 'pull-request';
  id?: string;
  /** The forge account the comment was posted as, when the forge reports it. */
  author?: { name: string; avatarUrl: string };
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  readonly baseUrl: string;
  readonly host: string;
  /** Forges mureview can only read from so far. */
  readonly readOnly?: boolean;
  listRepos(): Promise<ForgeRepo[]>;
  ensureRepo(repo: string, options?: ForgeCallOptions): Promise<void>;
  listBranches(repo: string, options?: ForgeCallOptions): Promise<BranchInfo[]>;
  getBranch(repo: string, branch: string, options?: ForgeCallOptions): Promise<BranchInfo | null>;
  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult>;
  mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null>;
  listBlobs(repo: string, sha: string): Promise<TreeListing>;
  getBlobText(repo: string, sha: string): Promise<string | null>;
  ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string, mureviewUrl?: string): Promise<PullRequestRef>;
  mergePullRequest(repo: string, number: number, message: string): Promise<string>;
  pullRequestUrl(repo: string, number: number): string;
  postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<PostedComment>;
  /** Removes a comment that exists on the forge; a missing comment is fine. */
  deleteComment(repo: string, number: number, commentId: string): Promise<void>;
  listComments(repo: string, number: number): Promise<ForgeComment[]>;
  fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null>;
  listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number; pullRequest?: number }): Promise<CommitInfo[]>;
  checks(repo: string, sha: string, options?: { pullRequest?: number }): Promise<ChecksSummary>;
  createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void>;
  /** When the stored credentials expire, if the forge reports it. */
  tokenExpiry?(): Promise<{ displayName: string; validTo: string } | null>;
  /**
   * Resolves what a "#123" (or Azure DevOps "!123") reference in a comment
   * points at, for rendering it as a link or chip.
   */
  resolveReference?(repo: string, type: 'pr' | 'issue' | 'work', id: string): Promise<RefInfo | null>;
  /**
   * Whether the connected account may complete pull requests in a repository:
   * 'unknown' when the forge cannot tell.
   */
  pullRequestPermission?(repo: string): Promise<'write' | 'read' | 'unknown'>;
  /** Resolves or reactivates the thread a comment belongs to, when supported. */
  setCommentResolved?(repo: string, number: number, commentId: string, resolved: boolean): Promise<void>;
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
