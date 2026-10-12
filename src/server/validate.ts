import type { RepoStatus } from '../shared/types';
import { GitHubError, getRepo, listBranches } from './github';
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

export async function inspectRepos(token: string, repos: string[], regex: RegExp | null): Promise<RepoStatus[]> {
  const statuses: RepoStatus[] = [];
  for (const repo of repos) {
    try {
      await getRepo(token, repo);
    } catch (error) {
      statuses.push(emptyRepoStatus(repo, `You don't have access to ${repo} (${githubErrorMessage(error)}).`));
      continue;
    }
    try {
      const branches = await listBranches(token, repo);
      const matches = regex ? matchingBranches(branches.map((branch) => branch.name), regex) : [];
      statuses.push({
        ...emptyRepoStatus(repo),
        accessible: true,
        matches,
        branch: matches.length === 1 ? matches[0] : null,
      });
    } catch (error) {
      statuses.push(emptyRepoStatus(repo, `Could not list branches for ${repo} (${githubErrorMessage(error)}).`));
    }
  }
  return statuses;
}
