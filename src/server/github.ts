const API = 'https://api.github.com';
const headers = (token: string, extra: HeadersInit = {}): HeadersInit => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'User-Agent': 'mureview',
  'X-GitHub-Api-Version': '2022-11-28',
  ...extra,
});

export class GitHubError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...init,
    headers: headers(token, init.headers),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { message?: string }).message ?? message;
    } catch {
      // keep status text
    }
    throw new GitHubError(res.status, message);
  }
  return (await res.json()) as T;
}

export async function ghPaginate<T>(token: string, path: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await gh<T[]>(token, `${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GithubBranch {
  name: string;
  commit: { sha: string };
}

export interface GithubCompareFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface GithubCompare {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  files?: GithubCompareFile[];
}

export interface GithubTreeEntry {
  path: string;
  sha: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

export const getUser = (token: string) => gh<GithubUser>(token, '/user');

export const getRepo = (token: string, repo: string) => gh<{ full_name: string }>(token, `/repos/${repo}`);

export const listBranches = (token: string, repo: string) => ghPaginate<GithubBranch>(token, `/repos/${repo}/branches`);

export const getBranch = (token: string, repo: string, branch: string) =>
  gh<GithubBranch>(token, `/repos/${repo}/branches/${encodeURIComponent(branch)}`);

export const compareBranches = (token: string, repo: string, base: string, head: string) =>
  gh<GithubCompare>(token, `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

export const getTree = (token: string, repo: string, sha: string) =>
  gh<{ tree: GithubTreeEntry[]; truncated: boolean }>(token, `/repos/${repo}/git/trees/${sha}?recursive=1`);

export async function getBlobText(token: string, repo: string, sha: string): Promise<string | null> {
  const res = await fetch(`${API}/repos/${repo}/git/blobs/${sha}`, {
    headers: headers(token, { Accept: 'application/vnd.github.raw' }),
  });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.includes(0)) return null;
  return buf.toString('utf8');
}
