import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { pullNumber } from './github';
import { addedFilePatch, deletedFilePatch, modifiedFilePatch, patchStats } from '../patch';
import {
  type BranchInfo,
  type CheckInfo,
  type ChecksSummary,
  type CommitInfo,
  type CompareFile,
  type CompareResult,
  type ForgeCallOptions,
  type ForgeClient,
  type ForgeComment,
  type ForgeRepo,
  ForgeError,
  type PostedComment,
  type RefInfo,
  type PullRequestRef,
  type ReviewComment,
  type TreeListing,
  decodeText,
  fetchImage,
  appendMureviewLink,
  withMureviewLink,
  organizationOf,
  statusMap,
  summarizeChecks,
} from './types';

const maxFileBytes = 200_000;
const maxFiles = 300;
const maxRefs = 2000;
const zeroObjectId = '0000000000000000000000000000000000000000';

// Azure DevOps answers unauthenticated requests with a 203 sign-in page, which
// fetch reports as ok.
const ok = (response: Response): boolean => response.ok && response.status !== 203;

interface AdoRepoItem {
  id: string;
  name: string;
  project: { id: string; name: string };
}

interface AdoRef {
  name: string;
  objectId: string;
}

interface AdoChange {
  changeType: string;
  item: { path: string; isFolder?: boolean; objectId?: string };
  originalPath?: string;
}

interface AdoDiffs {
  aheadCount: number;
  behindCount: number;
  allChangesIncluded?: boolean;
  commonCommit?: string;
  changes?: AdoChange[];
}

interface AdoItem {
  path: string;
  isFolder?: boolean;
  gitObjectType?: string;
  objectId?: string;
  size?: number;
}

interface AdoPull {
  pullRequestId: number;
  status: string;
  description?: string;
  lastMergeSourceCommit?: { commitId: string };
}

interface AdoCommentAuthor {
  displayName?: string;
  /** Deprecated by Azure DevOps in favour of the avatar link below. */
  imageUrl?: string;
  _links?: { avatar?: { href?: string } };
}

interface AdoThread {
  id: number;
  status?: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number };
    leftFileStart?: { line: number };
  };
  comments?: {
    id: number;
    parentCommentId?: number;
    commentType?: string;
    content?: string;
    publishedDate?: string;
    isDeleted?: boolean;
    author?: AdoCommentAuthor;
  }[];
}

interface AdoCommit {
  commitId: string;
  comment: string;
  author?: { name?: string; date?: string };
  remoteUrl?: string;
}

interface AdoPatToken {
  displayName?: string;
  scope?: string;
  validTo?: string;
  targetAccounts?: string[] | null;
  authorizationId?: string;
}

function toCommitInfo(commit: AdoCommit): CommitInfo {
  return {
    sha: commit.commitId,
    message: commit.comment.split('\n')[0],
    author: commit.author?.name ?? 'unknown',
    date: commit.author?.date ?? '',
    url: commit.remoteUrl,
  };
}

interface AdoEvaluation {
  status: 'queued' | 'running' | 'approved' | 'rejected' | 'notApplicable' | 'broken' | string;
  context?: { buildId?: number };
  configuration?: {
    isBlocking?: boolean;
    settings?: { displayName?: string };
    type?: { displayName?: string };
  };
}

const repoCache = new Cache<void>(200, 5 * 60_000);
const projectCache = new Cache<{ id: string; name: string }>(50, 60 * 60_000);
const branchListCache = new Cache<BranchInfo[]>(100, 45_000);
const branchCache = new Cache<BranchInfo | null>(300, 45_000);
const compareCache = new Cache<CompareResult>(60, 60 * 60_000);
const treeCache = new Cache<TreeListing>(60, 24 * 60 * 60_000);
const blobCache = new Cache<string>(400, 24 * 60 * 60_000);

export function invalidateAdoBranchCaches(): void {
  branchListCache.clear();
  branchCache.clear();
}

export function normalizeAdoOrganization(input: string): string {
  let value = input.trim();
  if (!value) throw new Error('Enter your Azure DevOps organization.');
  if (/^[\w-]+$/.test(value)) return `https://dev.azure.com/${value}`;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.host.toLowerCase() === 'dev.azure.com') {
    if (!segments.length) throw new Error('Include your organization in the URL, e.g. https://dev.azure.com/myorg.');
    return `https://dev.azure.com/${segments[0]}`;
  }
  return `${url.origin}${segments.length ? `/${segments[0]}` : ''}`;
}

export class AdoClient implements ForgeClient {
  readonly kind: ForgeKind = 'ado';
  readonly baseUrl: string;
  readonly host: string;

  constructor(baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.host = new URL(this.baseUrl).host;
  }

  private headers(accept = 'application/json'): HeadersInit {
    const credentials = Buffer.from(`:${this.token}`).toString('base64');
    return { Authorization: `Basic ${credentials}`, Accept: accept, 'User-Agent': 'mureview' };
  }

  private async fetchResponse(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, { ...init, headers: { ...this.headers(), ...init.headers } });
    if (!ok(response) && response.status !== 204) {
      if (response.status === 203) {
        throw new ForgeError(401, 'Azure DevOps rejected the credentials and returned its sign-in page');
      }
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // keep the status line
      }
      throw new ForgeError(response.status, message);
    }
    return response;
  }

  private async request<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const response = await this.fetchResponse(url, {
      ...rest,
      headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private repoUrl(repo: string): string {
    const slash = repo.indexOf('/');
    if (slash <= 0 || slash === repo.length - 1) throw new ForgeError(400, `"${repo}" is not a valid Azure DevOps repository (expected "project/repository").`);
    const project = encodeURIComponent(repo.slice(0, slash));
    const name = encodeURIComponent(repo.slice(slash + 1));
    return `${this.baseUrl}/${project}/_apis/git/repositories/${name}`;
  }

  async ensureOrg(): Promise<void> {
    await this.request(`${this.baseUrl}/_apis/projects?api-version=7.1&$top=1`);
  }

  /**
   * The account-level profile endpoint (app.vssps.visualstudio.com) rejects
   * organization-scoped tokens, which are the default when creating a PAT.
   * connectionData is scoped to the organization and works for both kinds.
   */
  async currentUser(): Promise<{ id: string; name: string; avatarUrl: string }> {    const data = await this.request<{
      authenticatedUser?: {
        id: string;
        providerDisplayName?: string;
        customDisplayName?: string;
        /** Deprecated by Azure DevOps in favour of the avatar link below. */
        imageUrl?: string;
        _links?: { avatar?: { href?: string } };
      };
    }>(`${this.baseUrl}/_apis/connectionData?api-version=7.1-preview.1`);
    const user = data.authenticatedUser;
    if (!user?.id || user.providerDisplayName === 'Anonymous') {
      throw new ForgeError(401, 'the personal access token is invalid, expired, or belongs to a different organization');
    }
    const onHost = (url: string) => {
      try {
        return new URL(url).host === this.host;
      } catch {
        return false;
      }
    };
    const href = user._links?.avatar?.href ?? '';
    const image = user.imageUrl ?? '';
    const fallback = `${this.baseUrl}/_api/_common/identityImage?id=${user.id}`;
    const avatarUrl = onHost(href) ? href : onHost(image) ? image : fallback;
    return { id: user.id, name: user.customDisplayName || user.providerDisplayName || 'azure devops', avatarUrl };
  }

  /**
   * Azure DevOps cannot report the expiry of the very token that is calling,
   * so list the user's personal access tokens and pick the most plausible
   * candidate: still valid, grants code access, applies to this
   * organization, and expires soonest. The token name is shown to the user
   * so they can tell which one is meant.
   */
  async tokenExpiry(): Promise<{ displayName: string; validTo: string } | null> {
    const connection = await this.request<{ instanceId?: string }>(
      `${this.baseUrl}/_apis/connectionData?api-version=7.1-preview.1`,
    );
    const path = '/_apis/tokens/pats?api-version=7.1-preview.1';
    let data: { patTokens?: AdoPatToken[] };
    try {
      data = await this.request<{ patTokens?: AdoPatToken[] }>(`${this.baseUrl}${path}`);
    } catch (error) {
      // Some organizations only answer this endpoint on the identity host.
      const org = organizationOf(this.baseUrl);
      if (!(error instanceof ForgeError) || !this.host.endsWith('dev.azure.com') || !org) throw error;
      data = await this.request<{ patTokens?: AdoPatToken[] }>(`https://vssps.dev.azure.com/${org}${path}`);
    }

    const now = Date.now();
    const candidates = (data.patTokens ?? [])
      .filter((token) => token.validTo && Number.isFinite(new Date(token.validTo).getTime()))
      .filter((token) => new Date(token.validTo!).getTime() > now)
      .filter((token) => !token.targetAccounts?.length || !connection.instanceId || token.targetAccounts.includes(connection.instanceId))
      .filter((token) => token.scope === 'app_token' || (token.scope ?? '').includes('vso.code'))
      .sort((a, b) => new Date(a.validTo!).getTime() - new Date(b.validTo!).getTime());

    const next = candidates[0];
    return next ? { displayName: next.displayName ?? 'unnamed', validTo: new Date(next.validTo!).toISOString() } : null;
  }

  async listRepos(): Promise<ForgeRepo[]> {
    try {
      const all = await this.request<{ value: AdoRepoItem[] }>(`${this.baseUrl}/_apis/git/repositories?api-version=7.1`);
      return all.value.map((repo) => ({ repo: `${repo.project.name}/${repo.name}`, private: true }));
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 404) throw error;
    }
    const projects = await this.request<{ value: { name: string }[] }>(`${this.baseUrl}/_apis/projects?api-version=7.1`);
    const repos: ForgeRepo[] = [];
    for (const project of projects.value.slice(0, 50)) {
      const list = await this.request<{ value: AdoRepoItem[] }>(
        `${this.baseUrl}/${encodeURIComponent(project.name)}/_apis/git/repositories?api-version=7.1`,
      );
      for (const repo of list.value) repos.push({ repo: `${repo.project.name}/${repo.name}`, private: true });
    }
    return repos;
  }

  async ensureRepo(repo: string, options: ForgeCallOptions = {}): Promise<void> {
    const key = `${this.baseUrl}#${repo}`;
    if (options.fresh) return void (await this.request(`${this.repoUrl(repo)}?api-version=7.1`));
    await cached(repoCache, key, async () => void (await this.request(`${this.repoUrl(repo)}?api-version=7.1`)));
  }

  private loadBranches(repo: string): Promise<BranchInfo[]> {
    return this.request<{ value: AdoRef[] }>(`${this.repoUrl(repo)}/refs?filter=heads/&api-version=7.1`).then((data) =>
      data.value.slice(0, maxRefs).map((ref) => ({ name: ref.name.replace(/^refs\/heads\//, ''), sha: ref.objectId })),
    );
  }

  async listBranches(repo: string, options: ForgeCallOptions = {}): Promise<BranchInfo[]> {
    const key = `${this.baseUrl}#${repo}`;
    if (options.fresh) return this.loadBranches(repo);
    return cached(branchListCache, key, () => this.loadBranches(repo));
  }

  async getBranch(repo: string, branch: string, options: ForgeCallOptions = {}): Promise<BranchInfo | null> {
    const key = `${this.baseUrl}#${repo}#${branch}`;
    const load = async (): Promise<BranchInfo | null> => {
      const data = await this.request<{ value: AdoRef[]; count: number }>(
        `${this.repoUrl(repo)}/refs?filter=${encodeURIComponent(`heads/${branch}`)}&api-version=7.1`,
      );
      const ref = data.value[0];
      return ref ? { name: branch, sha: ref.objectId } : null;
    };
    if (options.fresh) return load();
    const hit = branchCache.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    branchCache.set(key, value);
    return value;
  }

  private async contentAt(repo: string, sha: string, path: string): Promise<string | null> {
    const url =
      `${this.repoUrl(repo)}/items?path=${encodeURIComponent(`/${path}`)}&includeContent=true` +
      `&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&api-version=7.1`;
    const response = await fetch(url, { headers: this.headers('application/octet-stream') });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxFileBytes) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxFileBytes) return null;
    return decodeText(buffer);
  }

  private async buildFile(repo: string, baseSha: string, headSha: string, change: AdoChange): Promise<CompareFile | null> {
    const raw = change.changeType.toLowerCase();
    const type: FileStatus = raw.includes('add')
      ? 'added'
      : raw.includes('delete')
        ? 'deleted'
        : raw.includes('rename')
          ? 'renamed'
          : (statusMap[raw] ?? 'modified');
    const path = change.item.path.replace(/^\//, '');
    const prevPath = change.originalPath?.replace(/^\//, '');
    const base = { path, prevPath, type, patch: null as string | null, additions: 0, deletions: 0 };

    let patch: string | null = null;
    if (type === 'added') {
      const content = await this.contentAt(repo, headSha, path);
      if (content !== null) patch = addedFilePatch(path, content);
    } else if (type === 'deleted') {
      const content = await this.contentAt(repo, baseSha, path);
      if (content !== null) patch = deletedFilePatch(path, content);
    } else {
      const [oldContent, newContent] = await Promise.all([
        this.contentAt(repo, baseSha, prevPath ?? path),
        this.contentAt(repo, headSha, path),
      ]);
      if (oldContent !== null && newContent !== null) patch = modifiedFilePatch({ path, prevPath, type }, oldContent, newContent);
    }
    if (patch === null) return base;

    const stats = patchStats(patch);
    return { ...base, patch, additions: stats.additions, deletions: stats.deletions };
  }

  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult> {
    return cached(compareCache, `${this.baseUrl}#${repo}:${baseSha}...${headSha}`, async () => {
      const diffs = await this.request<AdoDiffs>(
        `${this.repoUrl(repo)}/diffs/commits?baseVersion=${baseSha}&targetVersion=${headSha}` +
          `&baseVersionType=commit&targetVersionType=commit&$top=${maxFiles + 1}&api-version=7.1`,
      );
      const changed = (diffs.changes ?? []).filter((change) => !change.item.isFolder);
      const capped = changed.slice(0, maxFiles);
      const files: CompareFile[] = [];
      for (const change of capped) {
        const file = await this.buildFile(repo, baseSha, headSha, change);
        if (file) files.push(file);
      }
      return {
        merged: diffs.aheadCount === 0,
        aheadBy: diffs.aheadCount,
        behindBy: diffs.behindCount,
        files,
        commits: [],
        truncated: changed.length > capped.length,
      };
    });
  }

  async mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null> {
    const diffs = await this.request<AdoDiffs>(
      `${this.repoUrl(repo)}/diffs/commits?baseVersion=${baseSha}&targetVersion=${headSha}` +
        `&baseVersionType=commit&targetVersionType=commit&$top=1&api-version=7.1`,
    );
    return diffs.commonCommit ?? null;
  }

  listBlobs(repo: string, sha: string): Promise<TreeListing> {
    return cached(treeCache, `${this.baseUrl}#${repo}#${sha}`, async () => {
      const data = await this.request<{ value: AdoItem[] }>(
        `${this.repoUrl(repo)}/items?recursionLevel=Full&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&api-version=7.1`,
      );
      const items = data.value.filter((item) => item.gitObjectType === 'blob' && !item.isFolder);
      const blobs = items.map((item) => ({ path: item.path.replace(/^\//, ''), sha: item.objectId ?? '', size: item.size ?? 0 }));
      return { blobs, truncated: items.length > 5000 };
    });
  }

  async getBlobText(repo: string, sha: string): Promise<string | null> {
    const key = `${this.baseUrl}#${repo}#${sha}`;
    const hit = blobCache.get(key);
    if (hit !== undefined) return hit;
    const response = await fetch(`${this.repoUrl(repo)}/blobs/${sha}?api-version=7.1`, {
      headers: this.headers('application/octet-stream'),
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxFileBytes) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxFileBytes) return null;
    const value = decodeText(buffer);
    if (value !== null) blobCache.set(key, value);
    return value;
  }

  async ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string, mureviewUrl?: string): Promise<PullRequestRef> {
    const description = withMureviewLink(body ?? 'Created by mureview.', mureviewUrl);
    try {
      const created = await this.request<AdoPull>(`${this.repoUrl(repo)}/pullrequests?api-version=7.1`, {
        method: 'POST',
        json: {
          sourceRefName: `refs/heads/${head}`,
          targetRefName: `refs/heads/${base}`,
          title,
          description,
        },
      });
      return { ref: String(created.pullRequestId), created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 409) throw error;
      const query =
        `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${head}`)}` +
        `&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${base}`)}` +
        `&searchCriteria.status=active&api-version=7.1`;
      const active = await this.request<{ value: AdoPull[] }>(`${this.repoUrl(repo)}/pullrequests?${query}`);
      const existing = active.value?.[0];
      if (!existing) throw new ForgeError(409, 'a conflicting pull request already exists');
      if (mureviewUrl) {
        const next = appendMureviewLink(existing.description, mureviewUrl);
        if (next !== null) {
          await this.request(`${this.repoUrl(repo)}/pullrequests/${existing.pullRequestId}?api-version=7.1`, {
            method: 'PATCH',
            json: { description: next },
          });
        }
      }
      return { ref: String(existing.pullRequestId), created: false };
    }
  }

  pullRequestUrl(repo: string, ref: string): string {
    const number = ref;
    const slash = repo.indexOf('/');
    const project = encodeURIComponent(repo.slice(0, slash));
    const name = encodeURIComponent(repo.slice(slash + 1));
    return `${this.baseUrl}/${project}/_git/${name}/pullrequest/${number}`;
  }

  async mergePullRequest(repo: string, ref: string, message: string): Promise<string> {
    const number = pullNumber(ref);
    const pull = await this.request<AdoPull>(`${this.repoUrl(repo)}/pullrequests/${number}?api-version=7.1`);
    await this.request(`${this.repoUrl(repo)}/pullrequests/${number}?api-version=7.1`, {
      method: 'PATCH',
      json: {
        status: 'completed',
        lastMergeSourceCommit: pull.lastMergeSourceCommit,
        completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false, mergeCommitMessage: message },
      },
    });
    return `merged pull request #${number}`;
  }

  async retargetPullRequest(repo: string, ref: string, base: string): Promise<void> {
    await this.request(`${this.repoUrl(repo)}/pullrequests/${pullNumber(ref)}?api-version=7.1`, {
      method: 'PATCH',
      json: { targetRefName: `refs/heads/${base}` },
    });
  }

  async postReviewComment(repo: string, ref: string, comment: ReviewComment): Promise<PostedComment> {
    const number = pullNumber(ref);
    const replyTo = comment.replyTo?.match(/^(\d+):(\d+)$/);
    if (replyTo) {
      try {
        const created = await this.request<{ id: number; author?: AdoCommentAuthor }>(
          `${this.repoUrl(repo)}/pullrequests/${number}/threads/${replyTo[1]}/comments?api-version=7.1`,
          {
            method: 'POST',
            json: { parentCommentId: Number(replyTo[2]), content: comment.body, commentType: 'text' },
          },
        );
        return { kind: 'line', id: `${replyTo[1]}:${created.id}`, author: this.commentAuthor(created.author) };
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        // The thread may be gone; start a new thread below.
      }
    }
    const line = { line: comment.line, offset: 1 };
    const context =
      comment.side === 'additions'
        ? { filePath: `/${comment.path}`, rightFileStart: line, rightFileEnd: line }
        : { filePath: `/${comment.path}`, leftFileStart: line, leftFileEnd: line };
    const threadId = (thread: AdoThread) => (thread.comments?.[0]?.id !== undefined ? `${thread.id}:${thread.comments[0].id}` : String(thread.id));
    try {
      const thread = await this.request<AdoThread>(`${this.repoUrl(repo)}/pullrequests/${number}/threads?api-version=7.1`, {
        method: 'POST',
        json: {
          comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
          status: 'active',
          threadContext: context,
        },
      });
      return { kind: 'line', id: threadId(thread), author: this.commentAuthor(thread.comments?.[0]?.author) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      const thread = await this.request<AdoThread>(`${this.repoUrl(repo)}/pullrequests/${number}/threads?api-version=7.1`, {
        method: 'POST',
        json: {
          comments: [{ parentCommentId: 0, content: `${comment.path}:${comment.line}\n\n${comment.body}`, commentType: 'text' }],
          status: 'active',
        },
      });
      return { kind: 'pull-request', id: threadId(thread), author: this.commentAuthor(thread.comments?.[0]?.author) };
    }
  }

  /** The account a posted comment belongs to, for display in mureview. */
  private commentAuthor(author?: AdoCommentAuthor): { name: string; avatarUrl: string } | undefined {
    if (!author) return undefined;
    return { name: author.displayName ?? '', avatarUrl: this.avatarUrl(author) };
  }

  /**
   * Azure DevOps stores avatars on the organization host; the deprecated
   * imageUrl field sometimes points elsewhere. Prefer whichever URL our own
   * host check can serve through the avatar proxy.
   */
  private avatarUrl(author?: AdoCommentAuthor): string {
    const href = author?._links?.avatar?.href ?? '';
    const image = author?.imageUrl ?? '';
    const onHost = (url: string) => {
      try {
        return new URL(url).host === this.host;
      } catch {
        return false;
      }
    };
    if (onHost(href)) return href;
    if (onHost(image)) return image;
    return href || image;
  }

  async setCommentResolved(repo: string, ref: string, commentId: string, resolved: boolean): Promise<void> {
    const number = pullNumber(ref);
    const match = commentId.match(/^(\d+):/);
    if (!match) throw new ForgeError(400, 'the comment is not part of a thread');
    await this.request(`${this.repoUrl(repo)}/pullrequests/${number}/threads/${match[1]}?api-version=7.1`, {
      method: 'PATCH',
      json: { status: resolved ? 'fixed' : 'active' },
    });
  }

  async deleteComment(repo: string, ref: string, commentId: string): Promise<void> {
    const number = pullNumber(ref);
    const match = commentId.match(/^(\d+):(\d+)$/);
    if (!match) return;
    try {
      await this.request(
        `${this.repoUrl(repo)}/pullrequests/${number}/threads/${match[1]}/comments/${match[2]}?api-version=7.1`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return;
      throw error;
    }
  }

  async listComments(repo: string, ref: string): Promise<ForgeComment[]> {
    const number = pullNumber(ref);
    const data = await this.request<{ value: AdoThread[] }>(`${this.repoUrl(repo)}/pullrequests/${number}/threads?api-version=7.1`);
    const comments: ForgeComment[] = [];
    for (const thread of data.value ?? []) {
      const context = thread.threadContext;
      const path = context?.filePath?.replace(/^\//, '');
      const rightLine = context?.rightFileStart?.line;
      const leftLine = context?.leftFileStart?.line;
      const anchored = Boolean(path) && (rightLine !== undefined || leftLine !== undefined);
      const resolved = thread.status ? thread.status !== 'active' && thread.status !== 'pending' : undefined;
      for (const comment of thread.comments ?? []) {
        if (comment.isDeleted) continue;
        if (comment.commentType && comment.commentType !== 'text') continue;
        if (!comment.content) continue;
        comments.push({
          id: `${thread.id}:${comment.id}`,
          author: {
            name: comment.author?.displayName ?? 'unknown',
            avatarUrl: this.avatarUrl(comment.author),
          },
          body: anchored ? comment.content : `**${path ?? 'pull request'}**\n\n${comment.content}`,
          createdAt: comment.publishedDate ?? '',
          path: anchored ? path : undefined,
          line: anchored ? (rightLine ?? leftLine) : undefined,
          side: anchored && rightLine === undefined ? 'deletions' : anchored ? 'additions' : undefined,
          replyToId: comment.parentCommentId ? `${thread.id}:${comment.parentCommentId}` : undefined,
          resolved,
        });
      }
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolveReference(repo: string, type: 'pr' | 'issue' | 'work', id: string): Promise<RefInfo | null> {
    if (!/^\d+$/.test(id)) return null;
    if (type === 'work') {
      const work = await this.request<{ fields?: Record<string, string>; _links?: { html?: { href?: string } } }>(
        `${this.baseUrl}/_apis/wit/workitems/${id}?api-version=7.1`,
      );
      const project = repo.split('/')[0];
      return {
        url: work._links?.html?.href ?? `${this.baseUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
        title: work.fields?.['System.Title'] ?? '',
        kind: 'work',
      };
    }
    // Pull request ids are unique per organization, so a "!123" reference can
    // point at any repository; the lookup tells us which one.
    const pull = await this.request<{
      pullRequestId?: number;
      title?: string;
      repository?: { name?: string; webUrl?: string; project?: { name?: string } };
    }>(`${this.baseUrl}/_apis/git/pullrequests/${id}?api-version=7.1`);
    const org = organizationOf(this.baseUrl);
    const project = pull.repository?.project?.name;
    const name = pull.repository?.name;
    const web =
      pull.repository?.webUrl ?? (org && project && name ? `https://${this.host}/${org}/${encodeURIComponent(project)}/_git/${name}` : null);
    if (!web) return null;
    return { url: `${web.replace(/\/+$/, '')}/pullrequest/${pull.pullRequestId ?? id}`, title: pull.title ?? '', kind: 'pr' };
  }

  /**
   * Azure DevOps stores mentions as `@<identity-id>`. The identity APIs live
   * on vssps (or the organization's vssps subdomain), not the organization's
   * own host, and older organizations only answer the preview api-version.
   */
  private identityBases(): string[] {
    const org = organizationOf(this.baseUrl);
    const bases: string[] = [];
    if (this.host.endsWith('.visualstudio.com')) bases.push(`https://vssps.${this.host}`);
    else if (org) bases.push(`https://vssps.${this.host}/${encodeURIComponent(org)}`);
    bases.push(this.baseUrl);
    return bases;
  }

  async resolveMention(id: string): Promise<{ name: string; url?: string } | null> {
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    let lastError: unknown = null;
    for (const base of this.identityBases()) {
      for (const version of ['7.1', '7.1-preview.1']) {
        try {
          const identity = await this.request<{
            providerDisplayName?: string;
            customDisplayName?: string;
            properties?: { Account?: { $value?: string } };
          }>(`${base}/_apis/identities/${id}?api-version=${version}`);
          const name = identity.customDisplayName ?? identity.providerDisplayName ?? identity.properties?.Account?.$value;
          if (name) return { name };
          return null;
        } catch (error) {
          lastError = error;
        }
      }
    }
    console.error(`Could not resolve the Azure DevOps mention ${id}:`, lastError);
    return null;
  }

  async fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null> {
    return fetchImage(url, this.headers('image/*'));
  }

  /** The commits of a pull request, exactly as the Azure DevOps UI lists them. */
  private async pullRequestCommits(repo: string, number: number, limit: number): Promise<CommitInfo[] | null> {
    try {
      const commits: AdoCommit[] = [];
      const seen = new Set<string>();
      let continuation: string | null = null;
      for (let page = 0; page < 6 && commits.length < limit; page++) {
        const paging = continuation ? `&continuationToken=${encodeURIComponent(continuation)}` : `&$skip=${page * 100}`;
        const response = await this.fetchResponse(`${this.repoUrl(repo)}/pullrequests/${number}/commits?$top=100${paging}&api-version=7.1`);
        const data = (await response.json()) as AdoCommit[] | { value?: AdoCommit[] };
        const batch = Array.isArray(data) ? data : (data.value ?? []);
        for (const commit of batch) {
          if (seen.has(commit.commitId)) continue;
          seen.add(commit.commitId);
          commits.push(commit);
        }
        continuation = response.headers.get('x-ms-continuationtoken');
        if (!continuation && batch.length < 100) break;
      }
      return commits
        .slice(0, limit)
        .map(toCommitInfo)
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      return null;
    }
  }

  async listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number; pullRequest?: string }): Promise<CommitInfo[]> {
    const limit = Math.min(options.limit ?? 300, 500);
    // The pull request endpoint matches what the Azure DevOps UI shows; the
    // branch comparison below is the fallback when no pull request is known.
    if (options.pullRequest) {
      const fromPullRequest = await this.pullRequestCommits(repo, pullNumber(options.pullRequest), limit);
      if (fromPullRequest) return fromPullRequest;
    }
    const compare = options.baseSha
      ? `&searchCriteria.compareVersion.version=${encodeURIComponent(options.baseSha)}&searchCriteria.compareVersion.versionType=commit`
      : '';
    // The commits endpoint pages with $skip and, on busy repositories, a
    // continuation token; walking them avoids silently dropping commits of
    // long-running branches.
    const commits: AdoCommit[] = [];
    const seen = new Set<string>();
    let continuation: string | null = null;
    for (let page = 0; page < 6 && commits.length < limit; page++) {
      const paging = continuation ? `&continuationToken=${encodeURIComponent(continuation)}` : `&searchCriteria.$skip=${page * 100}`;
      const url =
        `${this.repoUrl(repo)}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(options.headSha)}` +
        `&searchCriteria.itemVersion.versionType=commit${compare}&searchCriteria.$top=100${paging}&api-version=7.1`;
      const response = await this.fetchResponse(url);
      const data = (await response.json()) as { value?: AdoCommit[] };
      const batch = data.value ?? [];
      for (const commit of batch) {
        if (seen.has(commit.commitId)) continue;
        seen.add(commit.commitId);
        commits.push(commit);
      }
      continuation = response.headers.get('x-ms-continuationtoken');
      if (!continuation && batch.length < 100) break;
    }
    // Both the commits and the pull request endpoints list newest first.
    return commits.slice(0, limit).map(toCommitInfo);
  }

  /**
   * Azure DevOps checks are the pull request's policy evaluations (build
   * validation, required reviewers, status policies). Commit statuses are
   * ordinary pipeline runs and are not used, so a repository without a pull
   * request reports no checks.
   */
  async checks(repo: string, _sha: string, options: { pullRequest?: string } = {}): Promise<ChecksSummary> {
    if (!options.pullRequest) return { state: 'none', runs: [] };
    const pullRef = pullNumber(options.pullRequest);
    try {
      const project = await this.project(repo);
      const artifactId = `vstfs:///CodeReview/CodeReviewId/${project.id}/${pullRef}`;
      const data = await this.request<{ value: AdoEvaluation[] }>(
        `${this.baseUrl}/${encodeURIComponent(project.name)}/_apis/policy/evaluations` +
          `?artifactId=${encodeURIComponent(artifactId)}&api-version=7.1-preview.1`,
      );
      const runs: CheckInfo[] = (data.value ?? []).map((evaluation) => ({
        name: evaluation.configuration?.settings?.displayName ?? evaluation.configuration?.type?.displayName ?? 'policy',
        state:
          evaluation.status === 'approved'
            ? 'success'
            : evaluation.status === 'rejected' || evaluation.status === 'broken'
              ? 'failure'
              : evaluation.status === 'notApplicable'
                ? 'neutral'
                : 'pending',
        description: evaluation.configuration?.isBlocking === false ? 'non-blocking policy' : undefined,
        url: evaluation.context?.buildId
          ? `${this.baseUrl}/${encodeURIComponent(project.name)}/_build/results?buildId=${evaluation.context.buildId}`
          : undefined,
      }));
      return { state: summarizeChecks(runs), runs };
    } catch {
      return { state: 'unknown', runs: [] };
    }
  }

  private project(repo: string): Promise<{ id: string; name: string }> {
    const name = repo.slice(0, repo.indexOf('/'));
    return cached(projectCache, `${this.baseUrl}#${name}`, async () => {
      const project = await this.request<{ id: string; name: string }>(`${this.baseUrl}/_apis/projects/${encodeURIComponent(name)}?api-version=7.1`);
      return { id: project.id, name: project.name };
    });
  }

  async createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void> {
    await this.request(`${this.repoUrl(repo)}/refs?api-version=7.1`, {
      method: 'POST',
      json: [{ name: `refs/heads/${target}`, oldObjectId: zeroObjectId, newObjectId: from.sha }],
    });
  }

  private identity: { id: string; uniqueName: string } | null = null;

  private async currentIdentity(): Promise<{ id: string; uniqueName: string }> {
    if (this.identity) return this.identity;
    const data = await this.request<{ authenticatedUser?: { id?: string; uniqueName?: string } }>(
      `${this.baseUrl}/_apis/connectionData?api-version=7.1`,
    );
    const id = data.authenticatedUser?.id ?? '';
    const uniqueName = data.authenticatedUser?.uniqueName ?? '';
    if (!id) throw new ForgeError(401, 'could not read the Azure DevOps identity of this token');
    this.identity = { id, uniqueName };
    return this.identity;
  }

  async pullRequestReview(repo: string, ref: string): Promise<'approve' | 'waiting' | 'reject' | null> {
    const identity = await this.currentIdentity();
    const data = await this.request<{ reviewers?: Array<{ id?: string; uniqueName?: string; vote?: number }> }>(
      `${this.repoUrl(repo)}/pullRequests/${ref}?api-version=7.1`,
    );
    const own = (data.reviewers ?? []).find(
      (reviewer) => reviewer.id === identity.id || (reviewer.uniqueName ?? '').toLowerCase() === identity.uniqueName.toLowerCase(),
    );
    if (!own) return null;
    if ((own.vote ?? 0) >= 5) return 'approve';
    if ((own.vote ?? 0) <= -10) return 'reject';
    return 'waiting';
  }

  async reviewPullRequest(repo: string, ref: string, vote: 'approve' | 'waiting' | 'reject'): Promise<void> {
    const identity = await this.currentIdentity();
    const data = await this.request<{ reviewers?: Array<{ id?: string; uniqueName?: string }> }>(
      `${this.repoUrl(repo)}/pullRequests/${ref}?api-version=7.1`,
    );
    const own = (data.reviewers ?? []).find(
      (reviewer) => reviewer.id === identity.id || (reviewer.uniqueName ?? '').toLowerCase() === identity.uniqueName.toLowerCase(),
    );
    if (!own?.id) throw new ForgeError(400, 'you are not a reviewer on this pull request yet');
    await this.request(`${this.repoUrl(repo)}/pullRequests/${ref}/reviewers/${own.id}?api-version=7.1`, {
      method: 'PUT',
      json: { vote: vote === 'approve' ? 10 : vote === 'reject' ? -10 : 0 },
    });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    const ref = await this.getBranch(repo, branch);
    if (!ref) return;
    try {
      await this.request(`${this.repoUrl(repo)}/refs?api-version=7.1`, {
        method: 'POST',
        json: [{ name: `refs/heads/${branch}`, oldObjectId: ref.sha, newObjectId: zeroObjectId }],
      });
    } catch (error) {
      if (error instanceof ForgeError && (error.status === 404 || error.status === 409)) return;
      throw error;
    }
  }
}


