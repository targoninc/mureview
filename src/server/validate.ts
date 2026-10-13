import type { RepoStatus, ReviewSetRepo } from '../shared/types';
import { mapLimit } from './cache';
import { type ForgeClient, ForgeError } from './forges';
import { parseRepoList } from './repos';

/**
 * Splits a comma-separated pattern list, ignoring commas that are escaped or
 * part of a character class ([a,b]) or a quantifier ({1,3}).
 */
export function splitPatterns(input: string): string[] {
  const patterns: string[] = [];
  let current = '';
  let inClass = false;
  let inBraces = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '\\') {
      current += char + (input[index + 1] ?? '');
      index++;
      continue;
    }
    if (inClass) {
      current += char;
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      current += char;
      continue;
    }
    if (char === '{') {
      inBraces = true;
      current += char;
      continue;
    }
    if (char === '}') {
      inBraces = false;
      current += char;
      continue;
    }
    if (char === ',' && !inBraces) {
      patterns.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  patterns.push(current.trim());
  return patterns.filter(Boolean);
}

export interface CompiledPatterns {
  patterns: RegExp[];
  error: string | null;
}

export function compilePatterns(input: string): CompiledPatterns {
  const parts = splitPatterns(input);
  if (!parts.length) return { patterns: [], error: 'A branch pattern is required.' };
  const patterns: RegExp[] = [];
  for (const part of parts) {
    try {
      patterns.push(new RegExp(part));
    } catch {
      return { patterns: [], error: `"${part}" is not a valid regular expression.` };
    }
  }
  return { patterns, error: null };
}

export function matchingBranches(branches: string[], patterns: RegExp[]): string[] {
  return branches.filter((name) => patterns.some((pattern) => pattern.test(name)));
}

export function forgeErrorMessage(error: unknown): string {
  if (error instanceof ForgeError) {
    const detail = error.message?.trim();
    const rateLimited = /rate limit|too many requests|secondary rate/i.test(detail ?? '');
    if (error.status === 401) return 'authentication failed — reconnect this forge under Settings';
    if (error.status === 403) {
      if (rateLimited) return `rate limit reached (${detail})`;
      return detail ? `access forbidden (${detail})` : 'access forbidden';
    }
    if (error.status === 404) return 'not found or no access';
    return detail || `request failed with status ${error.status}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
}

export function emptyRepoStatus(repo: ReviewSetRepo, error?: string, defaultTarget = ''): RepoStatus {
  return {
    connectionId: repo.connectionId,
    kind: repo.kind,
    host: repo.host,
    org: repo.org,
    repo: repo.repo,
    accessible: !error,
    error,
    matches: [],
    branch: null,
    target: repo.target ?? defaultTarget,
    targetExists: false,
    state: error ? 'error' : 'no-match',
  };
}

export function multiMatchError(status: RepoStatus): string | null {
  if (!status.accessible || status.matches.length <= 1) return null;
  const shown = status.matches.slice(0, 5).join(', ');
  const list = status.matches.length > 5 ? `${shown}, …` : shown;
  return `${status.host}/${status.repo}: ${status.matches.length} branches match your patterns (${list}). The patterns together must match at most one branch per repository.`;
}

export interface LocatedRepo {
  status: RepoStatus;
  sha: string | null;
}

export interface InspectOptions {
  /** Regular expressions to match branches against, in pattern mode. */
  patterns: RegExp[];
  /** In per-repo mode every repository has its own branch. */
  perRepo?: boolean;
  /** The target branch to fall back to when a repository has none. */
  defaultTarget?: string;
  fresh?: boolean;
}

export async function inspectRepos(
  clients: Map<number, ForgeClient>,
  repos: ReviewSetRepo[],
  options: InspectOptions,
  onPhase?: (repo: ReviewSetRepo, phase: 'checking' | 'done' | 'error') => void,
): Promise<LocatedRepo[]> {
  const { patterns, perRepo = false, defaultTarget = '', fresh = false } = options;
  return mapLimit(repos, 4, async (repo): Promise<LocatedRepo> => {
    const client = clients.get(repo.connectionId);
    if (!client) {
      onPhase?.(repo, 'error');
      return { status: emptyRepoStatus(repo, `The connection for ${repo.host} was removed.`, defaultTarget), sha: null };
    }
    onPhase?.(repo, 'checking');
    try {
      await client.ensureRepo(repo.repo, { fresh });
    } catch (error) {
      onPhase?.(repo, 'error');
      return {
        status: emptyRepoStatus(repo, `You don't have access to ${repo.host}/${repo.repo} (${forgeErrorMessage(error)}).`, defaultTarget),
        sha: null,
      };
    }
    try {
      const branches = await client.listBranches(repo.repo, { fresh });
      const matches = perRepo
        ? repo.branch && branches.some((branch) => branch.name === repo.branch)
          ? [repo.branch]
          : []
        : matchingBranches(
            branches.map((branch) => branch.name),
            patterns,
          );
      const branch = matches.length === 1 ? matches[0] : null;
      const sha = branch ? (branches.find((candidate) => candidate.name === branch)?.sha ?? null) : null;
      if (!sha) onPhase?.(repo, 'done');
      return { status: { ...emptyRepoStatus(repo, undefined, defaultTarget), accessible: true, matches, branch }, sha };
    } catch (error) {
      onPhase?.(repo, 'error');
      return {
        status: emptyRepoStatus(repo, `Could not list branches for ${repo.host}/${repo.repo} (${forgeErrorMessage(error)}).`, defaultTarget),
        sha: null,
      };
    }
  });
}

export { parseRepoList };
