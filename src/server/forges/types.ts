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
  /** When set, the message already explains the fix and is shown verbatim. */
  friendly: boolean;

  constructor(status: number, message: string, friendly = false) {
    super(message);
    this.status = status;
    this.friendly = friendly;
  }
}

export interface ForgeRepo {
  repo: string;
  private: boolean;
  updatedAt?: string;
}

/** A group of repositories one connection offers, e.g. a GitHub App installation. */
export interface ForgeRepoSource {
  /** Identifies the group within the connection. */
  key: string;
  /** The account the repositories belong to; null for the connection's own account. */
  account: string | null;
  repos: ForgeRepo[];
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
  /** The common ancestor of the compared revisions, when the forge reports it. */
  mergeBase?: string;
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
  /** The forge's own identifier: a number for most forges, a record key for Tangled. */
  ref: string;
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

/**
 * The description with the mureview link appended, or null when it is already
 * there, when the description could not be read (undefined), or when the forge
 * would have to truncate it to fit (`maxLength`). Never risk losing text.
 */
export function appendMureviewLink(body: string | null | undefined, url: string, maxLength = Number.POSITIVE_INFINITY): string | null {
  if (body === undefined) return null;
  const text = (body ?? '').trim();
  if (text.includes(url)) return null;
  const next = text ? `${text}\n\n${mureviewLink(url)}` : mureviewLink(url);
  return next.length > maxLength ? null : next;
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
  /**
   * The repository groups this connection offers; a GitHub connection with
   * app installations returns the account plus one group per installation.
   * Forges without groups answer with the account's repositories alone.
   */
  listRepoSources?(): Promise<ForgeRepoSource[]>;
  ensureRepo(repo: string, options?: ForgeCallOptions): Promise<void>;
  listBranches(repo: string, options?: ForgeCallOptions): Promise<BranchInfo[]>;
  getBranch(repo: string, branch: string, options?: ForgeCallOptions): Promise<BranchInfo | null>;
  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult>;
  mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null>;
  listBlobs(repo: string, sha: string): Promise<TreeListing>;
  getBlobText(repo: string, sha: string): Promise<string | null>;
  ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string, mureviewUrl?: string): Promise<PullRequestRef>;
  mergePullRequest(repo: string, ref: string, message: string): Promise<string>;
  pullRequestUrl(repo: string, ref: string): string;
  postReviewComment(repo: string, ref: string, comment: ReviewComment): Promise<PostedComment>;
  /** Removes a comment that exists on the forge; a missing comment is fine. */
  deleteComment(repo: string, ref: string, commentId: string): Promise<void>;
  listComments(repo: string, ref: string): Promise<ForgeComment[]>;
  fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null>;
  listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number; pullRequest?: string }): Promise<CommitInfo[]>;
  checks(repo: string, sha: string, options?: { pullRequest?: string }): Promise<ChecksSummary>;
  createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void>;
  /** Deletes a branch after it has been merged; a missing branch is fine. */
  deleteBranch?(repo: string, branch: string): Promise<void>;
  /** The acting user's review decision on a pull request, when the forge has reviews. */
  pullRequestReview?(repo: string, ref: string): Promise<'approve' | 'waiting' | 'reject' | null>;
  /** Records the acting user's review decision on a pull request. */
  reviewPullRequest?(repo: string, ref: string, vote: 'approve' | 'waiting' | 'reject'): Promise<void>;
  /** Everyone's review decision on a pull request, when the forge reports them. */
  pullRequestReviews?(repo: string, ref: string): Promise<Array<{ name: string; avatarUrl?: string; vote: 'approve' | 'waiting' | 'reject'; you?: boolean }>>;
  /** The pull request's current state and branches on the forge. */
  pullRequestState?(repo: string, ref: string): Promise<{ state: 'open' | 'closed' | 'merged'; head: string; base: string } | null>;
  /** Registers a webhook that pushes live updates into mureview. */
  registerWebhook?(repo: string, url: string, secret: string): Promise<boolean>;
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
  /**
   * The acting account's own role, ignoring any app credential the forge
   * answers with; the acting account's access always decides.
   */
  ownPermission?(repo: string): Promise<'write' | 'read' | 'unknown'>;
  /**
   * Points an existing pull request at another base branch; stacked review
   * sets use it to land every layer on the shared target, bottom-up.
   */
  retargetPullRequest?(repo: string, ref: string, base: string): Promise<void>;
  /** Resolves or reactivates the thread a comment belongs to, when supported. */
  setCommentResolved?(repo: string, ref: string, commentId: string, resolved: boolean): Promise<void>;
  /**
   * Names the account behind a forge-specific mention, like Azure DevOps's
   * `@<identity-id>`, so comment bodies can show it like the forge does.
   */
  resolveMention?(id: string): Promise<{ name: string; url?: string } | null>;
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

export function commitInfo(input: {
  sha: string;
  message: string;
  author?: string | null;
  date?: string | null;
  url?: string;
}): CommitInfo {
  return {
    sha: input.sha,
    message: (input.message ?? '').split('\n')[0],
    author: input.author || 'unknown',
    date: input.date || '',
    ...(input.url ? { url: input.url } : {}),
  };
}

export function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

const maxAvatarBytes = 2_000_000;
const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

async function readLimited(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Fetches an image, with optional forge credentials, for the avatar proxy.
 * Redirects are followed only on the same origin: a forged avatar URL must not
 * turn the server into a proxy for another host, and credentials must not
 * travel to it. SVG is rejected because serving it from this origin would make
 * an avatar URL a script execution surface when opened directly.
 */
export async function fetchImage(url: string, headers?: HeadersInit): Promise<{ contentType: string; body: Buffer } | null> {
  let current = url;
  for (let redirects = 0; redirects < 4; redirects++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const response = await fetch(parsed, { headers, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      const next = new URL(location, current);
      if (next.origin !== parsed.origin) return null;
      await response.body?.cancel().catch(() => undefined);
      current = next.toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!imageTypes.has(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await readLimited(response, maxAvatarBytes);
    if (!body?.length) return null;
    return { contentType, body };
  }
  return null;
}

/** The avatar fetch GitHub, Forgejo and Tangled share. */
export function fetchForgeAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null> {
  return fetchImage(url, { 'User-Agent': 'mureview' });
}

export function summarizeChecks(runs: CheckInfo[]): ChecksSummary['state'] {
  if (!runs.length) return 'none';
  if (runs.some((run) => run.state === 'failure')) return 'failure';
  if (runs.some((run) => run.state === 'pending' || run.state === 'unknown')) return 'pending';
  return 'success';
}
