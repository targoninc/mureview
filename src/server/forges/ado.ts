import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { addedFilePatch, deletedFilePatch, modifiedFilePatch, patchStats } from '../patch';
import {
  type BranchInfo,
  type CheckInfo,
  type ChecksSummary,
  type CompareFile,
  type CompareResult,
  type ForgeCallOptions,
  type ForgeClient,
  type ForgeRepo,
  ForgeError,
  type PullRequestRef,
  type ReviewComment,
  type TreeListing,
  decodeText,
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
  lastMergeSourceCommit?: { commitId: string };
}

const repoCache = new Cache<void>(200, 5 * 60_000);
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

  private async request<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const { json, ...rest } = init;
    const response = await fetch(url, {
      ...rest,
      headers: { ...this.headers(), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
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
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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
  async currentUser(): Promise<{ id: string; name: string }> {
    const data = await this.request<{
      authenticatedUser?: { id: string; providerDisplayName?: string; customDisplayName?: string };
    }>(`${this.baseUrl}/_apis/connectionData?api-version=7.1-preview.1`);
    const user = data.authenticatedUser;
    if (!user?.id || user.providerDisplayName === 'Anonymous') {
      throw new ForgeError(401, 'the personal access token is invalid, expired, or belongs to a different organization');
    }
    return { id: user.id, name: user.customDisplayName || user.providerDisplayName || 'azure devops' };
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

  async ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string): Promise<PullRequestRef> {
    try {
      const created = await this.request<AdoPull>(`${this.repoUrl(repo)}/pullrequests?api-version=7.1`, {
        method: 'POST',
        json: {
          sourceRefName: `refs/heads/${head}`,
          targetRefName: `refs/heads/${base}`,
          title,
          description: body ?? 'Created by mureview.',
        },
      });
      return { number: created.pullRequestId, created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 409) throw error;
      const query =
        `searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${head}`)}` +
        `&searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${base}`)}` +
        `&searchCriteria.status=active&api-version=7.1`;
      const active = await this.request<{ value: AdoPull[] }>(`${this.repoUrl(repo)}/pullrequests?${query}`);
      if (!active.value?.length) throw new ForgeError(409, 'a conflicting pull request already exists');
      return { number: active.value[0].pullRequestId, created: false };
    }
  }

  pullRequestUrl(repo: string, number: number): string {
    const slash = repo.indexOf('/');
    const project = encodeURIComponent(repo.slice(0, slash));
    const name = encodeURIComponent(repo.slice(slash + 1));
    return `${this.baseUrl}/${project}/_git/${name}/pullrequest/${number}`;
  }

  async mergePullRequest(repo: string, number: number, message: string): Promise<string> {
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

  async postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<'line' | 'pull-request'> {
    const line = { line: comment.line, offset: 1 };
    const context =
      comment.side === 'additions'
        ? { filePath: `/${comment.path}`, rightFileStart: line, rightFileEnd: line }
        : { filePath: `/${comment.path}`, leftFileStart: line, leftFileEnd: line };
    try {
      await this.request(`${this.repoUrl(repo)}/pullrequests/${number}/threads?api-version=7.1`, {
        method: 'POST',
        json: {
          comments: [{ parentCommentId: 0, content: comment.body, commentType: 'text' }],
          status: 'active',
          threadContext: context,
        },
      });
      return 'line';
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      await this.request(`${this.repoUrl(repo)}/pullrequests/${number}/threads?api-version=7.1`, {
        method: 'POST',
        json: {
          comments: [{ parentCommentId: 0, content: `${comment.path}:${comment.line}\n\n${comment.body}`, commentType: 'text' }],
          status: 'active',
        },
      });
      return 'pull-request';
    }
  }

  async checks(repo: string, sha: string): Promise<ChecksSummary> {
    try {
      const statuses = await this.request<{
        value: { state: string; description?: string; context?: { name?: string; genre?: string }; targetUrl?: string }[];
      }>(`${this.repoUrl(repo)}/commits/${sha}/statuses?api-version=7.1`);
      const runs: CheckInfo[] = (statuses.value ?? []).map((entry) => ({
        name: entry.context?.name ?? 'status',
        state:
          entry.state === 'succeeded'
            ? 'success'
            : entry.state === 'pending'
              ? 'pending'
              : entry.state === 'notApplicable'
                ? 'neutral'
                : 'failure',
        description: entry.description,
        url: entry.targetUrl,
      }));
      return { state: summarizeChecks(runs), runs };
    } catch {
      return { state: 'unknown', runs: [] };
    }
  }

  async createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void> {
    await this.request(`${this.repoUrl(repo)}/refs?api-version=7.1`, {
      method: 'POST',
      json: [{ name: `refs/heads/${target}`, oldObjectId: zeroObjectId, newObjectId: from.sha }],
    });
  }
}


