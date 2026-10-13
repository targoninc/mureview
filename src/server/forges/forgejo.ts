import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
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
  type ReviewComment,
  type TreeListing,
  decodeText,
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
}

const maxFileBytes = 200_000;
const maxFiles = 300;

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

  constructor(baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.host = new URL(this.baseUrl).host;
    this.api = `${this.baseUrl}/api/v1`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.api}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `token ${this.token}`,
        'User-Agent': 'mureview',
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

  async ensurePullRequest(repo: string, base: string, head: string, title: string, body = 'Created by mureview.'): Promise<PullRequestRef> {
    try {
      const pull = await this.request<GiteaPull>(`/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ head, base, title, body }),
      });
      return { number: pull.number, created: true };
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 409) throw error;
      const pulls = await this.request<GiteaPull[]>(`/repos/${repo}/pulls?state=open&limit=50`);
      const existing = pulls.find((pull) => pull.head.ref === head && pull.base.ref === base);
      if (!existing) throw new ForgeError(409, 'a conflicting pull request already exists');
      return { number: existing.number, created: false };
    }
  }

  pullRequestUrl(repo: string, number: number): string {
    return `${this.baseUrl}/${repo}/pulls/${number}`;
  }

  async mergePullRequest(repo: string, number: number, message: string): Promise<string> {
    await this.request(`/repos/${repo}/pulls/${number}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Do: 'merge', MergeTitleField: message, MergeMessageField: message }),
    });
    return `merged pull request #${number}`;
  }

  async postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<PostedComment> {
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

  async listComments(repo: string, number: number): Promise<ForgeComment[]> {
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
        });
      }
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    return commits
      .slice(0, limit)
      .map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message.split('\n')[0],
        author: commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
        date: commit.commit.author?.date ?? '',
        url: commit.html_url,
      }))
      .reverse();
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
}

export async function getForgejoUser(baseUrl: string, token: string): Promise<{ id: number; login: string; full_name: string; avatar_url: string }> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/user`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'mureview' },
  });
  if (!response.ok) throw new ForgeError(response.status, response.statusText);
  return (await response.json()) as { id: number; login: string; full_name: string; avatar_url: string };
}
