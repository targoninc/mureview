import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
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
  type PullRequestRef,
  type ReviewComment,
  type TreeListing,
  decodeText,
  fetchImage,
  statusMap,
  summarizeChecks,
} from './types';

const API = 'https://api.github.com';

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

  constructor(private token: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(API + path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'User-Agent': 'mureview',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        message = ((await response.json()) as { message?: string }).message ?? message;
      } catch {
        // keep status text
      }
      throw new ForgeError(response.status, message);
    }
    return (await response.json()) as T;
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
    const response = await fetch(`${API}/repos/${repo}/git/blobs/${sha}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'mureview' },
    });
    if (!response.ok) return null;
    const value = decodeText(Buffer.from(await response.arrayBuffer()));
    if (value !== null) blobCache.set(key, value);
    return value;
  }

  async ensurePullRequest(repo: string, base: string, head: string, title: string, body = ''): Promise<PullRequestRef> {
    try {
      const created = await this.request<{ number: number }>(`/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, head, base, body }),
      });
      return { number: created.number, created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 422) throw error;
      const [owner] = repo.split('/');
      const existing = await this.request<{ number: number }[]>(
        `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}`,
      );
      if (!existing.length) throw error;
      return { number: existing[0].number, created: false };
    }
  }

  pullRequestUrl(repo: string, number: number): string {
    return `https://github.com/${repo}/pull/${number}`;
  }

  async mergePullRequest(repo: string, number: number, message: string): Promise<string> {
    await this.request(`/repos/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: 'merge', commit_title: message }),
    });
    return `merged pull request #${number}`;
  }

  async postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<{ kind: 'line' | 'pull-request'; id?: string }> {
    if (comment.replyTo) {
      try {
        const reply = await this.request<{ id: number }>(`/repos/${repo}/pulls/${number}/comments/${comment.replyTo}/replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: comment.body }),
        });
        return { kind: 'line', id: String(reply.id) };
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        // The parent is not a review comment (an issue comment, say); fall
        // back to posting a regular comment below.
      }
    }
    try {
      const created = await this.request<{ id: number }>(`/repos/${repo}/pulls/${number}/comments`, {
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
      return { kind: 'line', id: String(created.id) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      // The line may not be part of the pull request diff; keep the comment.
      const created = await this.request<{ id: number }>(`/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `${comment.path}:${comment.line}\n\n${comment.body}` }),
      });
      return { kind: 'pull-request', id: String(created.id) };
    }
  }

  async listComments(repo: string, number: number): Promise<ForgeComment[]> {
    const reviewComments = await this.paginate<GithubReviewComment>(`/repos/${repo}/pulls/${number}/comments`);
    const issueComments = await this.paginate<GithubIssueComment>(`/repos/${repo}/issues/${number}/comments`);
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
    const commits = await this.request<GithubCommit[]>(`/repos/${repo}/commits?sha=${options.headSha}&per_page=${Math.min(limit, 100)}`);
    return commits.map(toCommitInfo).reverse();
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
}

export const getUser = (token: string) =>
  fetch(`${API}/user`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'mureview' },
  }).then(async (response) => {
    if (!response.ok) throw new ForgeError(response.status, response.statusText);
    return (await response.json()) as GithubUser;
  });
