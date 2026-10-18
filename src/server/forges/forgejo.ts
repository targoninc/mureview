import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { pullNumber } from './github';
// The database and crypto are imported lazily so importing this module (tests,
// type checks) never opens the database.
import type { ForgeConnectionRow } from '../db';
import { addedFilePatch, deletedFilePatch, modifiedFilePatch } from '../patch';
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
  type PullRequestRef,
  type RefInfo,
  type ReviewComment,
  type TreeListing,
  decodeText,
  appendMureviewLink,
  withMureviewLink,
  fetchImage,
  statusMap,
  summarizeChecks,
} from './types';

interface GiteaRepo {
  full_name: string;
  private: boolean;
  updated_at?: string;
}

interface GiteaBranch {
  name: string;
  commit: { id: string };
}

interface GiteaCompareFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}

interface GiteaCompare {
  total_commits: number;
  files?: GiteaCompareFile[];
  commits?: GiteaCommit[];
}

interface GiteaCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author?: { login: string } | null;
  html_url?: string;
}

interface GiteaIssueComment {
  id: number;
  body: string;
  created_at?: string;
  user?: { login: string; avatar_url: string } | null;
}

interface GiteaReviewComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  side?: string;
  created_at?: string;
  updated_at?: string;
  user?: { login: string; avatar_url: string } | null;
  poster?: { login: string; avatar_url: string } | null;
  /** Whoever resolved the conversation, when it is resolved. */
  resolver?: { login: string } | null;
}

interface GiteaReview {
  id: number;
  submitted_at?: string;
  user?: { login: string; avatar_url: string } | null;
  comments?: GiteaReviewComment[];
}

interface GiteaTree {
  tree: { path: string; sha: string; type: string; size?: number }[];
  truncated: boolean;
}

interface GiteaPull {
  number: number;
  head: { ref: string };
  base: { ref: string };
  body?: string | null;
}

const maxFileBytes = 200_000;
const maxFiles = 300;

export interface ForgejoAuth {
  /** Exchanges the stored refresh token for a new access token. */
  refresh: () => Promise<string>;
}

const refreshing = new Map<number, Promise<string>>();

/**
 * Exchanges a Forgejo (Gitea) OAuth2 refresh token. Gitea rotates refresh
 * tokens on every exchange, so the caller must store the returned one.
 */
export async function exchangeForgejoRefreshToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!body.access_token) {
    throw new ForgeError(401, body.error_description ?? body.error ?? 'could not refresh the Forgejo token — reconnect this forge under Settings');
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken };
}

/** Refreshes a connection's Forgejo token, sharing one exchange per connection. */
export function refreshForgejoToken(connectionId: number): Promise<string> {
  const pending = refreshing.get(connectionId);
  if (pending) return pending;
  const task = (async () => {
    const [{ db }, { decrypt, encrypt }] = await Promise.all([import('../db'), import('../crypto')]);
    const connection = db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(connectionId);
    if (!connection) throw new ForgeError(401, 'the Forgejo connection was removed');
    const refreshToken = connection.refresh_token ? decrypt(connection.refresh_token) : '';
    const clientId = connection.client_id;
    const clientSecret = connection.client_secret ? decrypt(connection.client_secret) : '';
    if (!refreshToken || !clientId || !clientSecret) {
      throw new ForgeError(401, 'the Forgejo token expired — reconnect this forge under Settings');
    }
    const tokens = await exchangeForgejoRefreshToken(connection.base_url, clientId, clientSecret, refreshToken);
    db.run('UPDATE forge_connections SET access_token = ?, refresh_token = ? WHERE id = ?', [
      encrypt(tokens.accessToken),
      encrypt(tokens.refreshToken),
      connectionId,
    ]);
    return tokens.accessToken;
  })().finally(() => refreshing.delete(connectionId));
  refreshing.set(connectionId, task);
  return task;
}

const repoCache = new Cache<void>(200, 5 * 60_000);
const branchListCache = new Cache<BranchInfo[]>(100, 45_000);
const branchCache = new Cache<BranchInfo | null>(300, 45_000);
const compareCache = new Cache<CompareResult>(60, 60 * 60_000);
const treeCache = new Cache<TreeListing>(60, 24 * 60 * 60_000);
const blobCache = new Cache<string>(400, 24 * 60 * 60_000);

export function invalidateForgejoBranchCaches(): void {
  branchListCache.clear();
  branchCache.clear();
}

export class ForgejoClient implements ForgeClient {
  readonly kind: ForgeKind = 'forgejo';
  readonly baseUrl: string;
  readonly host: string;
  private api: string;

  constructor(baseUrl: string, private token: string, private auth?: ForgejoAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.host = new URL(this.baseUrl).host;
    this.api = `${this.baseUrl}/api/v1`;
  }

  private async request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const response = await fetch(`${this.api}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${this.token}`,
        'User-Agent': 'mureview',
        ...init.headers,
      },
    });
    if (response.status === 401 && this.auth && !retried) {
      this.token = await this.auth.refresh();
      return this.request<T>(path, init, true);
    }
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = ((await response.json()) as { message?: string }).message ?? message;
      } catch {
        // keep status text
      }
      throw new ForgeError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private absoluteAvatar(url: string | undefined | null): string {
    if (!url) return '';
    try {
      return new URL(url, this.baseUrl).toString();
    } catch {
      return '';
    }
  }

  private async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.request<T[]>(`${path}${separator}limit=50&page=${page}`);
      out.push(...items);
      if (items.length < 50) break;
    }
    return out;
  }

  async listRepos(): Promise<ForgeRepo[]> {
    const repos = await this.paginate<GiteaRepo>('/user/repos');
    return repos.map((repo) => ({ repo: repo.full_name, private: repo.private, updatedAt: repo.updated_at }));
  }

  async ensureRepo(repo: string, options: ForgeCallOptions = {}): Promise<void> {
    const key = `${this.baseUrl}#${repo}`;
    if (options.fresh) return void (await this.request(`/repos/${repo}`));
    await cached(repoCache, key, async () => void (await this.request(`/repos/${repo}`)));
  }

  private loadBranches(repo: string): Promise<BranchInfo[]> {
    return this.paginate<GiteaBranch>(`/repos/${repo}/branches`).then((branches) =>
      branches.map((branch) => ({ name: branch.name, sha: branch.commit.id })),
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
      try {
        const found = await this.request<GiteaBranch>(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
        return { name: found.name, sha: found.commit.id };
      } catch (error) {
        if (error instanceof ForgeError && error.status === 404) return null;
        throw error;
      }
    };
    if (options.fresh) return load();
    const hit = branchCache.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    branchCache.set(key, value);
    return value;
  }

  private async ancestors(repo: string, sha: string, limit = 200): Promise<Set<string>> {
    const visited = new Set<string>();
    const queue = [sha];
    while (queue.length > 0 && visited.size < limit) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      try {
        const commit = await this.request<{ parents?: { sha: string }[] }>(`/repos/${repo}/git/commits/${current}`);
        for (const parent of commit.parents ?? []) queue.push(parent.sha);
      } catch {
        // treat unreadable commits as roots
      }
    }
    return visited;
  }

  async mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null> {
    const ours = await this.ancestors(repo, headSha);
    const theirs = await this.ancestors(repo, baseSha);
    for (const sha of ours) if (theirs.has(sha)) return sha;
    return null;
  }

  listBlobs(repo: string, sha: string): Promise<TreeListing> {
    return cached(treeCache, `${this.baseUrl}#${repo}#${sha}`, async () => {
      const tree = await this.request<GiteaTree>(`/repos/${repo}/git/trees/${sha}?recursive=true&per_page=1000`);
      const blobs = tree.tree
        .filter((entry) => entry.type === 'blob')
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
      return { blobs, truncated: tree.truncated };
    });
  }

  async getBlobText(repo: string, sha: string): Promise<string | null> {
    const key = `${this.baseUrl}#${repo}#${sha}`;
    const hit = blobCache.get(key);
    if (hit !== undefined) return hit;
    const blob = await this.request<{ content?: string }>(`/repos/${repo}/git/blobs/${sha}`);
    const value = blob.content ? decodeText(Buffer.from(blob.content, 'base64')) : null;
    if (value !== null) blobCache.set(key, value);
    return value;
  }

  private async blobAt(repo: string, ref: string, path: string): Promise<string | null> {
    const listing = await this.listBlobs(repo, ref);
    const blob = listing.blobs.find((entry) => entry.path === path);
    if (!blob || blob.size > maxFileBytes) return null;
    return this.getBlobText(repo, blob.sha);
  }

  private async buildFile(repo: string, baseSha: string, headSha: string, file: GiteaCompareFile): Promise<CompareFile> {
    const type: FileStatus = statusMap[file.status] ?? 'modified';
    const path = file.filename;
    const prevPath = file.previous_filename;
    const base = { path, prevPath, type, additions: file.additions, deletions: file.deletions, patch: null as string | null };

    if (type === 'added') {
      const content = await this.blobAt(repo, headSha, path);
      return content === null ? base : { ...base, patch: addedFilePatch(path, content) };
    }
    if (type === 'deleted') {
      const content = await this.blobAt(repo, baseSha, path);
      return content === null ? base : { ...base, patch: deletedFilePatch(path, content) };
    }

    const [oldContent, newContent] = await Promise.all([
      this.blobAt(repo, baseSha, prevPath ?? path),
      this.blobAt(repo, headSha, path),
    ]);
    if (oldContent === null || newContent === null) return base;
    return { ...base, patch: modifiedFilePatch({ path, prevPath, type }, oldContent, newContent) };
  }

  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult> {
    return cached(compareCache, `${this.baseUrl}#${repo}:${baseSha}...${headSha}`, async () => {
      const comparison = await this.request<GiteaCompare>(`/repos/${repo}/compare/${baseSha}...${headSha}`);
      const changed = comparison.files ?? [];
      const merged = comparison.total_commits === 0 && changed.length === 0;
      const capped = changed.slice(0, maxFiles);
      const files: CompareFile[] = [];
      for (const file of capped) {
        files.push(await this.buildFile(repo, baseSha, headSha, file));
      }
      return {
        merged,
        aheadBy: comparison.total_commits,
        behindBy: 0,
        files,
        commits: (comparison.commits ?? []).map((commit) => ({
          sha: commit.sha,
          message: commit.commit.message.split('\n')[0],
          author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
          date: commit.commit.author?.date ?? '',
          url: commit.html_url,
        })),
        truncated: changed.length > capped.length,
      };
    });
  }

  async ensurePullRequest(
    repo: string,
    base: string,
    head: string,
    title: string,
    body = 'Created by mureview.',
    mureviewUrl?: string,
  ): Promise<PullRequestRef> {
    try {
      const pull = await this.request<GiteaPull>(`/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ head, base, title, body: withMureviewLink(body, mureviewUrl) }),
      });
      return { ref: String(pull.number), created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 409) throw error;
      const pulls = await this.request<GiteaPull[]>(`/repos/${repo}/pulls?state=open&limit=50`);
      const existing = pulls.find((pull) => pull.head.ref === head && pull.base.ref === base);
      if (!existing) throw new ForgeError(409, 'a conflicting pull request already exists');
      if (mureviewUrl) {
        const next = appendMureviewLink(existing.body, mureviewUrl);
        if (next !== null) {
          await this.request(`/repos/${repo}/pulls/${existing.number}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: next }),
          });
        }
      }
      return { ref: String(existing.number), created: false };
    }
  }

  pullRequestUrl(repo: string, ref: string): string {
    return `${this.baseUrl}/${repo}/pulls/${ref}`;
  }

  async mergePullRequest(repo: string, ref: string, message: string): Promise<string> {
    const number = pullNumber(ref);
    await this.request(`/repos/${repo}/pulls/${number}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Do: 'merge', MergeTitleField: message, MergeMessageField: message }),
    });
    return `merged pull request #${number}`;
  }

  async retargetPullRequest(repo: string, ref: string, base: string): Promise<void> {
    await this.request(`/repos/${repo}/pulls/${pullNumber(ref)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base }),
    });
  }

  async postReviewComment(repo: string, ref: string, comment: ReviewComment): Promise<PostedComment> {
    const number = pullNumber(ref);
    if (comment.replyTo && /^\d+$/.test(comment.replyTo)) {
      try {
        const review = await this.request<{ comments?: GiteaReviewComment[] }>(`/repos/${repo}/pulls/${number}/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: 'COMMENT',
            commit_id: comment.commitId,
            comments: [{ body: comment.body, in_reply_to: Number(comment.replyTo) }],
          }),
        });
        const created = review.comments?.[0];
        return { kind: 'line', id: created ? String(created.id) : undefined, author: this.authorOf(created) };
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        // Older Forgejo versions do not know in_reply_to; post a regular
        // comment below instead.
      }
    }
    try {
      const review = await this.request<{ comments?: GiteaReviewComment[] }>(`/repos/${repo}/pulls/${number}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'COMMENT',
          commit_id: comment.commitId,
          comments: [
            {
              path: comment.path,
              body: comment.body,
              new_position: comment.side === 'additions' ? comment.line : 0,
              old_position: comment.side === 'deletions' ? comment.line : 0,
            },
          ],
        }),
      });
      const created = review.comments?.[0];
      return { kind: 'line', id: created ? String(created.id) : undefined, author: this.authorOf(created) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      const created = await this.request<{ id: number; user?: { login: string; avatar_url: string } | null }>(
        `/repos/${repo}/issues/${number}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: `${comment.path}:${comment.line}\n\n${comment.body}` }),
        },
      );
      return {
        kind: 'pull-request',
        id: String(created.id),
        author: created.user ? { name: created.user.login, avatarUrl: this.absoluteAvatar(created.user.avatar_url) } : undefined,
      };
    }
  }

  /** The account a posted review comment belongs to. */
  private authorOf(comment?: GiteaReviewComment): { name: string; avatarUrl: string } | undefined {
    const user = comment?.user ?? comment?.poster;
    return user ? { name: user.login, avatarUrl: this.absoluteAvatar(user.avatar_url) } : undefined;
  }

  async deleteComment(repo: string, _ref: string, commentId: string): Promise<void> {
    if (!/^\d+$/.test(commentId)) return;
    try {
      await this.request(`/repos/${repo}/issues/comments/${commentId}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return;
      throw error;
    }
  }

  async listComments(repo: string, ref: string): Promise<ForgeComment[]> {
    const number = pullNumber(ref);
    const issueComments = await this.paginate<GiteaIssueComment>(`/repos/${repo}/issues/${number}/comments`);
    const reviews = await this.paginate<GiteaReview>(`/repos/${repo}/pulls/${number}/reviews`);
    const comments: ForgeComment[] = [];

    for (const comment of issueComments) {
      comments.push({
        id: String(comment.id),
        author: { name: comment.user?.login ?? 'unknown', avatarUrl: this.absoluteAvatar(comment.user?.avatar_url) },
        body: comment.body,
        createdAt: comment.created_at ?? '',
      });
    }
    for (const review of reviews) {
      for (const comment of review.comments ?? []) {
        const author = comment.user ?? comment.poster ?? review.user;
        const anchored = Boolean(comment.path) && typeof comment.line === 'number' && comment.line > 0;
        comments.push({
          id: String(comment.id),
          author: { name: author?.login ?? 'unknown', avatarUrl: this.absoluteAvatar(author?.avatar_url) },
          body: anchored ? comment.body : `**${comment.path ?? 'review'}** (outdated)\n\n${comment.body}`,
          createdAt: comment.created_at ?? comment.updated_at ?? review.submitted_at ?? '',
          path: anchored ? comment.path : undefined,
          line: anchored ? (comment.line as number) : undefined,
          side: anchored ? (comment.side === 'LEFT' ? 'deletions' : 'additions') : undefined,
          resolved: comment.resolver ? true : undefined,
        });
      }
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async pullRequestPermission(repo: string): Promise<'write' | 'read' | 'unknown'> {
    try {
      const data = await this.request<{ permissions?: { admin?: boolean; push?: boolean } | null }>(`/repos/${repo}`);
      const permissions = data.permissions;
      if (!permissions) return 'unknown';
      return permissions.admin || permissions.push ? 'write' : 'read';
    } catch {
      return 'unknown';
    }
  }

  async resolveReference(repo: string, type: 'pr' | 'issue' | 'work', id: string): Promise<RefInfo | null> {
    if (type === 'work' || !/^\d+$/.test(id)) return null;
    const issue = await this.request<{ title?: string; html_url?: string; pull_request?: unknown }>(`/repos/${repo}/issues/${id}`);
    if (!issue.html_url) return null;
    return { url: issue.html_url, title: issue.title ?? '', kind: issue.pull_request ? 'pr' : 'issue' };
  }

  async fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null> {
    return fetchImage(url, { 'User-Agent': 'mureview' });
  }

  async listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number }): Promise<CommitInfo[]> {
    const limit = options.limit ?? 100;
    if (options.baseSha) {
      const comparison = await this.compare(repo, options.baseSha, options.headSha);
      return comparison.commits.slice(0, limit);
    }
    const perPage = Math.min(limit, 50);
    const commits = await this.request<GiteaCommit[]>(`/repos/${repo}/commits?sha=${options.headSha}&limit=${perPage}&page=1`);
    for (let page = 2; commits.length < limit; page++) {
      const next = await this.request<GiteaCommit[]>(`/repos/${repo}/commits?sha=${options.headSha}&limit=${perPage}&page=${page}`);
      if (!next.length) break;
      commits.push(...next);
    }
    // Both the compare and the commits endpoints list newest first.
    return commits.slice(0, limit).map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.split('\n')[0],
      author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
      date: commit.commit.author?.date ?? '',
      url: commit.html_url,
    }));
  }

  async checks(repo: string, sha: string): Promise<ChecksSummary> {
    try {
      const statuses = await this.request<{ context: string; status: string; description?: string; target_url?: string }[]>(
        `/repos/${repo}/commits/${sha}/statuses`,
      );
      const runs: CheckInfo[] = statuses.map((entry) => ({
        name: entry.context,
        state:
          entry.status === 'success'
            ? 'success'
            : entry.status === 'pending'
              ? 'pending'
              : entry.status === 'warning'
                ? 'neutral'
                : 'failure',
        description: entry.description,
        url: entry.target_url,
      }));
      return { state: summarizeChecks(runs), runs };
    } catch {
      return { state: 'unknown', runs: [] };
    }
  }

  async createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void> {
    await this.request(`/repos/${repo}/branches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ new_branch_name: target, old_branch_name: from.branch }),
    });
  }

  async registerWebhook(repo: string, url: string, secret: string): Promise<boolean> {
    try {
      await this.request(`/repos/${repo}/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'gitea',
          active: true,
          events: ['push', 'pull_request', 'pull_request_review', 'issue_comment'],
          config: { url, content_type: 'json', secret },
        }),
      });
      return true;
    } catch (error) {
      console.error(`Could not register a webhook for ${repo}:`, error);
      return false;
    }
  }

  async pullRequestState(repo: string, ref: string): Promise<{ state: 'open' | 'closed' | 'merged'; head: string; base: string } | null> {
    try {
      const pull = await this.request<{ state?: string; merged?: boolean; head?: { ref?: string }; base?: { ref?: string } }>(
        `/repos/${repo}/pulls/${ref}`,
      );
      return {
        state: pull.merged ? 'merged' : pull.state === 'closed' ? 'closed' : 'open',
        head: pull.head?.ref ?? '',
        base: pull.base?.ref ?? '',
      };
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return null;
      throw error;
    }
  }

  private login: string | null = null;

  private async currentLogin(): Promise<string> {
    if (this.login) return this.login;
    const user = await this.request<{ login: string }>('/user');
    this.login = user.login;
    return this.login;
  }

  async pullRequestReview(repo: string, ref: string): Promise<'approve' | 'waiting' | 'reject' | null> {
    const login = await this.currentLogin();
    const reviews = await this.request<Array<{ id: number; user?: { login?: string } | null; state?: string }>>(
      `/repos/${repo}/pulls/${ref}/reviews`,
    );
    const own = reviews.filter((review) => review.user?.login === login);
    const last = own[own.length - 1];
    if (!last) return null;
    if (last.state === 'APPROVED') return 'approve';
    if (last.state === 'REQUEST_CHANGES') return 'reject';
    return 'waiting';
  }

  async pullRequestReviews(repo: string, ref: string): Promise<Array<{ name: string; avatarUrl?: string; vote: 'approve' | 'waiting' | 'reject'; you?: boolean }>> {
    const login = await this.currentLogin().catch(() => '');
    const reviews = await this.request<Array<{ user?: { login?: string; avatar_url?: string } | null; state?: string }>>(
      `/repos/${repo}/pulls/${ref}/reviews`,
    );
    const latest = new Map<string, { name: string; avatarUrl?: string; vote: 'approve' | 'waiting' | 'reject'; you?: boolean }>();
    for (const review of reviews) {
      const name = review.user?.login;
      if (!name) continue;
      latest.set(name, {
        name,
        avatarUrl: review.user?.avatar_url,
        vote: review.state === 'APPROVED' ? 'approve' : review.state === 'REQUEST_CHANGES' ? 'reject' : 'waiting',
        you: name === login,
      });
    }
    return [...latest.values()];
  }

  async reviewPullRequest(repo: string, ref: string, vote: 'approve' | 'waiting' | 'reject'): Promise<void> {
    if (vote === 'waiting') {
      const login = await this.currentLogin();
      const reviews = await this.request<Array<{ id: number; user?: { login?: string } | null; state?: string }>>(
        `/repos/${repo}/pulls/${ref}/reviews`,
      );
      const own = reviews.filter((review) => review.user?.login === login && review.state !== 'COMMENT');
      const last = own[own.length - 1];
      if (!last) return;
      try {
        await this.request(`/repos/${repo}/pulls/${ref}/reviews/${last.id}/dismissals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Withdrawn in mureview' }),
        });
      } catch (error) {
        if (error instanceof ForgeError && (error.status === 404 || error.status === 405 || error.status === 422)) return;
        throw error;
      }
      return;
    }
    await this.request(`/repos/${repo}/pulls/${ref}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        vote === 'approve'
          ? { event: 'APPROVE', body: '' }
          : { event: 'REQUEST_CHANGES', body: 'Changes requested in mureview' },
      ),
    });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.request(`/repos/${repo}/branches/${branch}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return;
      throw error;
    }
  }
}

export async function getForgejoUser(baseUrl: string, token: string): Promise<{ id: number; login: string; full_name: string; avatar_url: string }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/user`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'mureview' },
  });
  if (!response.ok) throw new ForgeError(response.status, response.statusText);
  return (await response.json()) as { id: number; login: string; full_name: string; avatar_url: string };
}
