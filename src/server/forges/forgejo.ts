import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { addedFilePatch, deletedFilePatch, modifiedFilePatch } from '../patch';
import { type BranchInfo, type CompareFile, type CompareResult, type ForgeCallOptions, type ForgeClient, type ForgeRepo, ForgeError, type TreeListing, decodeText, statusMap } from './types';

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
        truncated: changed.length > capped.length,
      };
    });
  }

  async mergeBranch(repo: string, base: string, head: string, message: string): Promise<string> {
    let number: number;
    try {
      const pull = await this.request<GiteaPull>(`/repos/${repo}/pulls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ head, base, title: message, body: 'Created by mureview.' }),
      });
      number = pull.number;
    } catch (error) {
      if (!(error instanceof ForgeError) || error.status !== 409) throw error;
      const pulls = await this.request<GiteaPull[]>(`/repos/${repo}/pulls?state=open&limit=50`);
      const existing = pulls.find((pull) => pull.head.ref === head && pull.base.ref === base);
      if (!existing) throw new ForgeError(409, 'a conflicting pull request already exists');
      number = existing.number;
    }

    await this.request(`/repos/${repo}/pulls/${number}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Do: 'merge', MergeTitleField: message, MergeMessageField: message }),
    });
    return `merged pull request #${number}`;
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
