import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { config } from '../config';
// The database and crypto are imported lazily so importing this module (tests,
// type checks) never opens the database.
import type { ForgeConnectionRow } from '../db';
import { withPatchHeader } from '../patch';
import {
  type BranchInfo,
  type CheckInfo,
  type ChecksSummary,
  type CommitInfo,
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
  fetchImage,
  appendMureviewLink,
  withMureviewLink,
  statusMap,
  summarizeChecks,
} from './types';

const API = 'https://api.github.com';

/** Most forges number their pull requests; Tangled does not. */
export function pullNumber(ref: string): number {
  if (!/^\d+$/.test(ref)) throw new ForgeError(400, `pull request ${ref} is not a number`);
  return Number(ref);
}

export interface GithubAuth {
  /** Exchanges the stored refresh token for a new access token. */
  refresh: () => Promise<string>;
}

const refreshing = new Map<number, Promise<string>>();

/**
 * Exchanges a GitHub OAuth refresh token. GitHub rotates refresh tokens on
 * every exchange, so the caller must store the returned one.
 */
export async function exchangeGithubRefreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      grant_type: 'refresh_token',
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
    throw new ForgeError(401, body.error_description ?? body.error ?? 'could not refresh the GitHub token — reconnect GitHub under Settings');
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token ?? refreshToken };
}

/** Refreshes a connection's GitHub token, sharing one exchange per connection. */
export function refreshGithubToken(connectionId: number): Promise<string> {
  const pending = refreshing.get(connectionId);
  if (pending) return pending;
  const task = (async () => {
    const [{ db }, { decrypt, encrypt }] = await Promise.all([import('../db'), import('../crypto')]);
    const connection = db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(connectionId);
    if (!connection) throw new ForgeError(401, 'the GitHub connection was removed');
    const refreshToken = connection.refresh_token ? decrypt(connection.refresh_token) : '';
    if (!refreshToken) throw new ForgeError(401, 'the GitHub token expired — reconnect GitHub under Settings');
    const tokens = await exchangeGithubRefreshToken(refreshToken);
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

function authorOf(user?: GithubUser | null): { name: string; avatarUrl: string } | undefined {
  return user ? { name: user.login, avatarUrl: user.avatar_url ?? '' } : undefined;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface GithubBranch {
  name: string;
  commit: { sha: string };
}

interface GithubCompareFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GithubCompare {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  total_commits?: number;
  files?: GithubCompareFile[];
  commits?: GithubCommit[];
  merge_base_commit?: { sha: string };
}

interface GithubCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string } | null;
  html_url: string;
}

interface GithubReviewComment {
  id: number;
  user: { login: string; avatar_url: string } | null;
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  side: 'RIGHT' | 'LEFT' | null;
  created_at: string;
  in_reply_to_id?: number;
}

interface GithubIssueComment {
  id: number;
  user: { login: string; avatar_url: string } | null;
  body: string;
  created_at: string;
}

function toCommitInfo(commit: GithubCommit): CommitInfo {
  return {
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0],
    author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
    date: commit.commit.author?.date ?? '',
    url: commit.html_url,
  };
}

interface GithubTreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

interface GithubRepo {
  full_name: string;
  private: boolean;
  updated_at?: string;
}

const repoCache = new Cache<void>(200, 5 * 60_000);
const branchListCache = new Cache<BranchInfo[]>(100, 45_000);
const branchCache = new Cache<BranchInfo | null>(300, 45_000);
const compareCache = new Cache<CompareResult>(60, 60 * 60_000);
const treeCache = new Cache<TreeListing>(60, 24 * 60 * 60_000);
const blobCache = new Cache<string>(400, 24 * 60 * 60_000);

export function invalidateGithubBranchCaches(): void {
  branchListCache.clear();
  branchCache.clear();
}

export class GithubClient implements ForgeClient {
  readonly kind: ForgeKind = 'github';
  readonly baseUrl = 'https://github.com';
  readonly host = 'github.com';

  private login: string | null = null;

  constructor(private token: string, private auth?: GithubAuth) {}

  /** Refreshes an expired token once per request before giving up. */
  private async retryOnExpiry<T>(send: () => Promise<Response>, read: (response: Response) => Promise<T>): Promise<T> {
    let response = await send();
    if (response.status === 401 && this.auth) {
      this.token = await this.auth.refresh();
      response = await send();
    }
    return read(response);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.retryOnExpiry(
      () =>
        fetch(API + path, {
          ...init,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'mureview',
            'X-GitHub-Api-Version': '2022-11-28',
            ...init.headers,
          },
        }),
      async (response) => {
        if (!response.ok) {
          let message = response.statusText;
          try {
            message = ((await response.json()) as { message?: string }).message ?? message;
          } catch {
            // keep status text
          }
          throw new ForgeError(response.status, message);
        }
        if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
        return (await response.json()) as T;
      },
    );
  }

  private async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const items = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async listRepos(): Promise<ForgeRepo[]> {
    const repos = await this.paginate<GithubRepo>('/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name');
    return repos.map((repo) => ({ repo: repo.full_name, private: repo.private, updatedAt: repo.updated_at }));
  }

  async ensureRepo(repo: string, options: ForgeCallOptions = {}): Promise<void> {
    if (options.fresh) return void (await this.request(`/repos/${repo}`));
    await cached(repoCache, repo, async () => void (await this.request(`/repos/${repo}`)));
  }

  private loadBranches(repo: string): Promise<BranchInfo[]> {
    return this.paginate<GithubBranch>(`/repos/${repo}/branches`).then((branches) =>
      branches.map((branch) => ({ name: branch.name, sha: branch.commit.sha })),
    );
  }

  async listBranches(repo: string, options: ForgeCallOptions = {}): Promise<BranchInfo[]> {
    if (options.fresh) return this.loadBranches(repo);
    return cached(branchListCache, repo, () => this.loadBranches(repo));
  }

  async getBranch(repo: string, branch: string, options: ForgeCallOptions = {}): Promise<BranchInfo | null> {
    const key = `${repo}#${branch}`;
    const load = async (): Promise<BranchInfo | null> => {
      try {
        const found = await this.request<GithubBranch>(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
        return { name: found.name, sha: found.commit.sha };
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

  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult> {
    return cached(compareCache, `${repo}:${baseSha}...${headSha}`, async () => {
      const comparison = await this.request<GithubCompare>(`/repos/${repo}/compare/${baseSha}...${headSha}`);
      const merged = comparison.status === 'behind' || comparison.status === 'identical';
      const files = (comparison.files ?? []).map((file) => {
        const type: FileStatus = statusMap[file.status] ?? 'modified';
        return {
          path: file.filename,
          prevPath: file.previous_filename,
          type,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ? withPatchHeader({ path: file.filename, prevPath: file.previous_filename, type, patch: file.patch }) : null,
        };
      });
      return {
        merged,
        aheadBy: comparison.ahead_by,
        behindBy: comparison.behind_by,
        files,
        commits: (comparison.commits ?? []).map(toCommitInfo),
        truncated: files.length >= 300,
        mergeBase: comparison.merge_base_commit?.sha,
      };
    });
  }

  async mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null> {
    const comparison = await this.request<GithubCompare>(`/repos/${repo}/compare/${baseSha}...${headSha}`);
    return comparison.merge_base_commit?.sha ?? null;
  }

  listBlobs(repo: string, sha: string): Promise<TreeListing> {
    return cached(treeCache, `${repo}#${sha}`, async () => {
      const tree = await this.request<{ tree: GithubTreeEntry[]; truncated: boolean }>(`/repos/${repo}/git/trees/${sha}?recursive=1`);
      const blobs = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
      return { blobs, truncated: tree.truncated };
    });
  }

  async getBlobText(repo: string, sha: string): Promise<string | null> {
    const key = `${repo}#${sha}`;
    const hit = blobCache.get(key);
    if (hit !== undefined) return hit;
    const response = await this.retryOnExpiry(
      () =>
        fetch(`${API}/repos/${repo}/git/blobs/${sha}`, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'mureview' },
        }),
      async (result) => result,
    );
    if (!response.ok) return null;
    const value = decodeText(Buffer.from(await response.arrayBuffer()));
    if (value !== null) blobCache.set(key, value);
    return value;
  }

  async ensurePullRequest(repo: string, base: string, head: string, title: string, body = '', mureviewUrl?: string): Promise<PullRequestRef> {
    try {
      const created = await this.request<{ number: number }>(`/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, head, base, body: withMureviewLink(body, mureviewUrl) }),
      });
      return { ref: String(created.number), created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 422) throw error;
      const [owner] = repo.split('/');
      const existing = await this.request<{ number: number; body?: string | null }[]>(
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
      );
      if (!existing.length) throw error;
      const pull = existing[0];
      if (mureviewUrl) {
        const next = appendMureviewLink(pull.body, mureviewUrl);
        if (next !== null) {
          await this.request(`/repos/${repo}/pulls/${pull.number}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: next }),
          });
        }
      }
      return { ref: String(pull.number), created: false };
    }
  }

  pullRequestUrl(repo: string, ref: string): string {
    return `https://github.com/${repo}/pull/${ref}`;
  }

  async mergePullRequest(repo: string, ref: string, message: string): Promise<string> {
    const number = pullNumber(ref);
    await this.request(`/repos/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: 'merge', commit_title: message }),
    });
    return `merged pull request #${number}`;
  }

  async pullRequestReview(repo: string, ref: string): Promise<'approve' | 'waiting' | 'reject' | null> {
    const login = await this.currentLogin();
    const reviews = await this.paginate<{ user?: { login?: string }; state?: string }>(`/repos/${repo}/pulls/${pullNumber(ref)}/reviews`);
    const own = reviews.filter((review) => review.user?.login === login);
    const last = own[own.length - 1];
    if (!last) return null;
    if (last.state === 'APPROVED') return 'approve';
    if (last.state === 'CHANGES_REQUESTED') return 'reject';
    return 'waiting';
  }

  async reviewPullRequest(repo: string, ref: string, vote: 'approve' | 'waiting' | 'reject'): Promise<void> {
    const number = pullNumber(ref);
    if (vote === 'waiting') {
      const login = await this.currentLogin();
      const reviews = await this.paginate<{ id?: number; user?: { login?: string }; state?: string }>(`/repos/${repo}/pulls/${number}/reviews`);
      const own = reviews.filter((review) => review.user?.login === login && review.state !== 'COMMENTED');
      const last = own[own.length - 1];
      if (!last?.id) return;
      try {
        await this.request(`/repos/${repo}/pulls/${number}/reviews/${last.id}/dismissals`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Withdrawn in mureview' }),
        });
      } catch (error) {
        if (error instanceof ForgeError && (error.status === 404 || error.status === 422)) return;
        throw error;
      }
      return;
    }
    await this.request(`/repos/${repo}/pulls/${number}/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        vote === 'approve'
          ? { event: 'APPROVE' }
          : { event: 'REQUEST_CHANGES', body: 'Changes requested in mureview' },
      ),
    });
  }

  async pullRequestState(repo: string, ref: string): Promise<{ state: 'open' | 'closed' | 'merged'; head: string; base: string } | null> {
    try {
      const pull = await this.request<{ state?: string; merged?: boolean; head?: { ref?: string }; base?: { ref?: string } }>(
        `/repos/${repo}/pulls/${pullNumber(ref)}`,
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

  private async currentLogin(): Promise<string> {
    if (this.login) return this.login;
    const user = await this.request<{ login: string }>('/user');
    this.login = user.login;
    return this.login;
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
    if (comment.replyTo) {
      try {
        const reply = await this.request<{ id: number; user?: GithubUser | null }>(
          `/repos/${repo}/pulls/${number}/comments/${comment.replyTo}/replies`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: comment.body }),
          },
        );
        return { kind: 'line', id: String(reply.id), author: authorOf(reply.user) };
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        // The parent is not a review comment (an issue comment, say); fall
        // back to posting a regular comment below.
      }
    }
    try {
      const created = await this.request<{ id: number; user?: GithubUser | null }>(`/repos/${repo}/pulls/${number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: comment.body,
          path: comment.path,
          line: comment.line,
          side: comment.side === 'additions' ? 'RIGHT' : 'LEFT',
          commit_id: comment.commitId,
        }),
      });
      return { kind: 'line', id: String(created.id), author: authorOf(created.user) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      // The line may not be part of the pull request diff; keep the comment.
      const created = await this.request<{ id: number; user?: GithubUser | null }>(`/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `${comment.path}:${comment.line}\n\n${comment.body}` }),
      });
      return { kind: 'pull-request', id: String(created.id), author: authorOf(created.user) };
    }
  }

  async deleteComment(repo: string, _ref: string, commentId: string): Promise<void> {
    try {
      await this.request(`/repos/${repo}/pulls/comments/${commentId}`, { method: 'DELETE' });
      return;
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 404) throw error;
    }
    try {
      await this.request(`/repos/${repo}/issues/comments/${commentId}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * GitHub only exposes resolved review threads through GraphQL; this maps
   * every review comment id of the pull request to its thread's state.
   */
  private async reviewThreads(
    repo: string,
    number: number,
  ): Promise<{ id: string; isResolved: boolean; commentIds: string[] }[]> {
    const [owner, name] = repo.split('/');
    const data = await this.request<{
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: { id: string; isResolved: boolean; comments?: { nodes?: { databaseId: number }[] } }[];
            };
          };
        };
      };
      errors?: { message?: string }[];
    }>('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:
          'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}',
        variables: { owner, name, number },
      }),
    });
    if (data.errors?.length) throw new ForgeError(400, data.errors[0]?.message ?? 'the graphql query failed');
    return (data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      commentIds: (thread.comments?.nodes ?? []).map((comment) => String(comment.databaseId)),
    }));
  }

  async setCommentResolved(repo: string, ref: string, commentId: string, resolved: boolean): Promise<void> {
    const threads = await this.reviewThreads(repo, pullNumber(ref));
    const thread = threads.find((entry) => entry.commentIds.includes(commentId));
    if (!thread) throw new ForgeError(404, 'the review thread was not found');
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    const data = await this.request<{ errors?: { message?: string }[] }>('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `mutation($id:ID!){${mutation}(input:{threadId:$id}){thread{isResolved}}}`,
        variables: { id: thread.id },
      }),
    });
    if (data.errors?.length) throw new ForgeError(400, data.errors[0]?.message ?? 'the graphql mutation failed');
  }

  async listComments(repo: string, ref: string): Promise<ForgeComment[]> {
    const number = pullNumber(ref);
    const reviewComments = await this.paginate<GithubReviewComment>(`/repos/${repo}/pulls/${number}/comments`);
    const issueComments = await this.paginate<GithubIssueComment>(`/repos/${repo}/issues/${number}/comments`);
    const resolvedByComment = new Map<string, boolean>();
    try {
      for (const thread of await this.reviewThreads(repo, number)) {
        for (const id of thread.commentIds) resolvedByComment.set(id, thread.isResolved);
      }
    } catch (error) {
      console.error(`Could not read the review thread states for ${repo}#${number}:`, error);
    }
    const comments: ForgeComment[] = [];

    for (const comment of reviewComments) {
      const line = comment.line ?? comment.original_line ?? null;
      const anchored = Boolean(comment.path) && line !== null;
      comments.push({
        id: String(comment.id),
        author: { name: comment.user?.login ?? 'unknown', avatarUrl: comment.user?.avatar_url ?? '' },
        body: anchored ? comment.body : `**${comment.path}** (outdated)\n\n${comment.body}`,
        createdAt: comment.created_at,
        path: anchored ? comment.path : undefined,
        line: anchored ? (line as number) : undefined,
        side: anchored ? (comment.side === 'LEFT' ? 'deletions' : 'additions') : undefined,
        replyToId: comment.in_reply_to_id ? String(comment.in_reply_to_id) : undefined,
        resolved: resolvedByComment.get(String(comment.id)),
      });
    }
    for (const comment of issueComments) {
      comments.push({
        id: String(comment.id),
        author: { name: comment.user?.login ?? 'unknown', avatarUrl: comment.user?.avatar_url ?? '' },
        body: comment.body,
        createdAt: comment.created_at,
      });
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async pullRequestPermission(repo: string): Promise<'write' | 'read' | 'unknown'> {
    try {
      const data = await this.request<{ permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } | null }>(`/repos/${repo}`);
      const permissions = data.permissions;
      if (!permissions) return 'unknown';
      return permissions.admin || permissions.maintain || permissions.push ? 'write' : 'read';
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
      // The compare endpoint paginates its commit list, so walk the pages to
      // avoid silently truncated commit lists.
      const loadPage = (page: number) =>
        this.request<GithubCompare>(
          `/repos/${repo}/compare/${options.baseSha}...${options.headSha}?per_page=100&page=${page}`,
        );
      const first = await loadPage(1);
      if (!first.commits) return [];
      const commits = [...first.commits];
      const cap = Math.min(first.total_commits ?? commits.length, 300, limit);
      for (let page = 2; commits.length < cap; page++) {
        const next = await loadPage(page);
        if (!next.commits?.length) break;
        commits.push(...next.commits);
      }
      return commits.slice(0, limit).map(toCommitInfo);
    }
    const perPage = Math.min(limit, 100);
    const commits = await this.request<GithubCommit[]>(`/repos/${repo}/commits?sha=${options.headSha}&per_page=${perPage}`);
    for (let page = 2; commits.length < limit; page++) {
      const next = await this.request<GithubCommit[]>(`/repos/${repo}/commits?sha=${options.headSha}&per_page=${perPage}&page=${page}`);
      if (!next.length) break;
      commits.push(...next);
    }
    // The commits endpoint lists newest first.
    return commits.slice(0, limit).map(toCommitInfo);
  }

  async checks(repo: string, sha: string): Promise<ChecksSummary> {
    const runs: CheckInfo[] = [];
    try {
      const checkRuns = await this.request<{
        check_runs: { name: string; status: string; conclusion: string | null; details_url?: string; output?: { title?: string } }[];
      }>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
      for (const run of checkRuns.check_runs) {
        const state: CheckInfo['state'] =
          run.status !== 'completed'
            ? 'pending'
            : run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral'
              ? (run.conclusion as CheckInfo['state'])
              : run.conclusion === 'stale'
                ? 'neutral' // superseded by a newer run, not a failure
                : run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled' || run.conclusion === 'action_required'
                  ? 'failure'
                  : 'unknown';
        runs.push({ name: run.name, state, description: run.output?.title, url: run.details_url });
      }
    } catch {
      // no permission for check runs; fall back to commit statuses only
    }
    try {
      const status = await this.request<{ statuses: { context: string; state: string; description?: string; target_url?: string }[] }>(
        `/repos/${repo}/commits/${sha}/status`,
      );
      for (const entry of status.statuses) {
        runs.push({
          name: entry.context,
          state: entry.state === 'success' ? 'success' : entry.state === 'pending' ? 'pending' : 'failure',
          description: entry.description,
          url: entry.target_url,
        });
      }
    } catch {
      // no commit statuses
    }
    return { state: summarizeChecks(runs), runs };
  }

  async createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void> {
    await this.request(`/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${target}`, sha: from.sha }),
    });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.request(`/repos/${repo}/git/refs/heads/${branch}`, { method: 'DELETE' });
    } catch (error) {
      if (error instanceof ForgeError && (error.status === 404 || error.status === 422)) return;
      throw error;
    }
  }
}

export const getUser = (token: string) =>
  fetch(`${API}/user`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'mureview' },
  }).then(async (response) => {
    if (!response.ok) throw new ForgeError(response.status, response.statusText);
    return (await response.json()) as GithubUser;
  });
