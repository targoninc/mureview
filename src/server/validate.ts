import type { RepoStatus } from '../shared/types';
import { mapLimit } from './cache';
import { GitHubError, getRepoCached, listBranchesCached } from './github';
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

export function githubErrorMessage(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 404) return 'not found or no access';
    if (error.status === 403) return 'access forbidden (or GitHub rate limit reached)';
    return error.message;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

export interface RepoConfig {
  repos: string[];
  branchRegex: string;
}

export function validateConfigShape(input: RepoConfig): string[] {
  const errors: string[] = [];
  const { repos, invalid } = parseRepoList(input.repos);
  if (!repos.length) errors.push('Add at least one repository.');
  for (const raw of invalid) errors.push(`"${raw}" is not a valid repository (expected "owner/name").`);
  if (!input.branchRegex.trim()) errors.push('A branch pattern is required.');
  else if (!compileRegex(input.branchRegex)) errors.push('The branch pattern is not a valid regular expression.');
  return errors;
}

export function emptyRepoStatus(repo: string, error?: string): RepoStatus {
  return {
    repo,
    accessible: !error,
    error,
    matches: [],
    branch: null,
    targetExists: false,
    state: error ? 'error' : 'no-match',
  };
}

function truncateList(names: string[], max = 5): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown}, …` : shown;
}

export function multiMatchError(status: RepoStatus): string | null {
  if (!status.accessible || status.matches.length <= 1) return null;
  return `${status.repo}: ${status.matches.length} branches match your pattern (${truncateList(status.matches)}). A pattern must match at most one branch per repository.`;
}

export interface LocatedRepo {
  status: RepoStatus;
  sha: string | null;
}

export async function inspectRepos(token: string, repos: string[], regex: RegExp | null, fresh = false): Promise<LocatedRepo[]> {
  return mapLimit(repos, 4, async (repo): Promise<LocatedRepo> => {
    try {
      await getRepoCached(token, repo, fresh);
    } catch (error) {
      return { status: emptyRepoStatus(repo, `You don't have access to ${repo} (${githubErrorMessage(error)}).`), sha: null };
    }
    try {
      const branches = await listBranchesCached(token, repo, fresh);
      const matches = regex ? matchingBranches(branches.map((branch) => branch.name), regex) : [];
      const branch = matches.length === 1 ? matches[0] : null;
      const sha = branch ? (branches.find((candidate) => candidate.name === branch)?.commit.sha ?? null) : null;
      return { status: { ...emptyRepoStatus(repo), accessible: true, matches, branch }, sha };
    } catch (error) {
      return { status: emptyRepoStatus(repo, `Could not list branches for ${repo} (${githubErrorMessage(error)}).`), sha: null };
    }
  });
}
