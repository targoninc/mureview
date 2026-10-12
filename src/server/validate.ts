import type { RepoStatus, ReviewSetRepo } from '../shared/types';
import { mapLimit } from './cache';
import { type ForgeClient, ForgeError } from './forges';
import { parseRepoList } from './repos';

export function compileRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function matchingBranches(branches: string[], regex: RegExp): string[] {
  return branches.filter((name) => regex.test(name));
}

export function forgeErrorMessage(error: unknown): string {
  if (error instanceof ForgeError) {
    if (error.status === 404) return 'not found or no access';
    if (error.status === 403 || error.status === 401) return 'access forbidden (or rate limit reached)';
    return error.message;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

export function emptyRepoStatus(repo: ReviewSetRepo, error?: string): RepoStatus {
  return {
    connectionId: repo.connectionId,
    kind: repo.kind,
    host: repo.host,
    repo: repo.repo,
    accessible: !error,
    error,
    matches: [],
    branch: null,
    targetExists: false,
    state: error ? 'error' : 'no-match',
  };
}

export function multiMatchError(status: RepoStatus): string | null {
  if (!status.accessible || status.matches.length <= 1) return null;
  const shown = status.matches.slice(0, 5).join(', ');
  const list = status.matches.length > 5 ? `${shown}, …` : shown;
  return `${status.host}/${status.repo}: ${status.matches.length} branches match your pattern (${list}). A pattern must match at most one branch per repository.`;
}

export interface LocatedRepo {
  status: RepoStatus;
  sha: string | null;
}

export async function inspectRepos(
  clients: Map<number, ForgeClient>,
  repos: ReviewSetRepo[],
  regex: RegExp | null,
  fresh = false,
): Promise<LocatedRepo[]> {
  return mapLimit(repos, 4, async (repo): Promise<LocatedRepo> => {
    const client = clients.get(repo.connectionId);
    if (!client) return { status: emptyRepoStatus(repo, `The connection for ${repo.host} was removed.`), sha: null };
    try {
      await client.ensureRepo(repo.repo, { fresh });
    } catch (error) {
      return {
        status: emptyRepoStatus(repo, `You don't have access to ${repo.host}/${repo.repo} (${forgeErrorMessage(error)}).`),
        sha: null,
      };
    }
    try {
      const branches = await client.listBranches(repo.repo, { fresh });
      const matches = regex ? matchingBranches(branches.map((branch) => branch.name), regex) : [];
      const branch = matches.length === 1 ? matches[0] : null;
      const sha = branch ? (branches.find((candidate) => candidate.name === branch)?.sha ?? null) : null;
      return { status: { ...emptyRepoStatus(repo), accessible: true, matches, branch }, sha };
    } catch (error) {
      return { status: emptyRepoStatus(repo, `Could not list branches for ${repo.host}/${repo.repo} (${forgeErrorMessage(error)}).`), sha: null };
    }
  });
}

export { parseRepoList };
