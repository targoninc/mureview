import type { RepoStatus, ReviewSetRepo } from '../shared/types';
import { repoLabel } from '../shared/types';
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
    // Forges that explain themselves (Tangled's knots, token mints) say it
    // better than the generic advice below.
    if (error.friendly && detail) return detail;
    const rateLimited = /rate limit|too many requests|secondary rate/i.test(detail ?? '');
    // Errors that already tell the user what to do (Tangled asking for an
    // atproto sign-in, a failed token mint, a knot rejecting the write) are
    // more useful than the generic advice.
    if (error.status === 401 && detail && /atproto|service token|knot rejected/i.test(detail)) return detail;
    if (error.status === 401) return 'authentication failed — reconnect this forge under Settings';
    if (error.status === 403) {
      if (rateLimited) return `rate limit reached (${detail})`;
      // GitHub says this when an app token lacks a permission for the endpoint.
      if (/resource not accessible by integration/i.test(detail ?? '')) {
        return "the GitHub App is missing a permission for this action — add Contents: write (merging creates commits) and Pull requests: write to the app, approve the update, then retry";
      }
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
    position: repo.position,
    targetExists: false,
    state: error ? 'error' : 'no-match',
  };
}

export function multiMatchError(status: RepoStatus): string | null {
  if (!status.accessible || status.matches.length <= 1) return null;
  const shown = status.matches.slice(0, 5).join(', ');
  const list = status.matches.length > 5 ? `${shown}, …` : shown;
  return `${repoLabel(status)}: ${status.matches.length} branches match your patterns (${list}). The patterns together must match at most one branch per repository.`;
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
  /** In stack mode every repository has an ordered list of branches. */
  stack?: boolean;
  fresh?: boolean;
}

export async function inspectRepos(
  clients: Map<number, ForgeClient>,
  repos: ReviewSetRepo[],
  options: InspectOptions,
  onPhase?: (repo: ReviewSetRepo, phase: 'checking' | 'done' | 'error') => void,
): Promise<LocatedRepo[]> {
  const { patterns, perRepo = false, defaultTarget = '', stack = false, fresh = false } = options;

  // Layers of one repository share a branch listing and an access check.
  const groups = new Map<string, ReviewSetRepo[]>();
  for (const repo of repos) {
    const key = `${repo.connectionId}:${repo.repo}`;
    const group = groups.get(key) ?? [];
    group.push(repo);
    groups.set(key, group);
  }

  const inspected = await mapLimit([...groups.values()], 4, async (group): Promise<LocatedRepo[]> => {
    const first = group[0];
    const client = clients.get(first.connectionId);
    if (!client) {
      for (const repo of group) onPhase?.(repo, 'error');
      return group.map((repo) => ({ status: emptyRepoStatus(repo, `The connection for ${repo.host} was removed.`, defaultTarget), sha: null }));
    }
    onPhase?.(first, 'checking');
    try {
      await client.ensureRepo(first.repo, { fresh });
    } catch (error) {
      for (const repo of group) onPhase?.(repo, 'error');
      return group.map((repo) => ({
        status: emptyRepoStatus(repo, `You don't have access to ${repoLabel(first)} (${forgeErrorMessage(error)}).`, defaultTarget),
        sha: null,
      }));
    }
    let branches: Awaited<ReturnType<ForgeClient['listBranches']>>;
    try {
      branches = await client.listBranches(first.repo, { fresh });
    } catch (error) {
      for (const repo of group) onPhase?.(repo, 'error');
      return group.map((repo) => ({
        status: emptyRepoStatus(repo, `Could not list branches for ${repoLabel(first)} (${forgeErrorMessage(error)}).`, defaultTarget),
        sha: null,
      }));
    }

    if (stack) return inspectStack(group, branches, defaultTarget, onPhase);

    const repo = first;
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
    return [{ status: { ...emptyRepoStatus(repo, undefined, defaultTarget), accessible: true, matches, branch }, sha }];
  });
  return inspected.flat();
}

/**
 * Walks a repository's layers bottom-up: each layer is compared against the
 * one below it (the review set's target branch for the bottom layer). A layer
 * whose branch is gone is skipped, and the layers above it are compared
 * against the last branch that does exist.
 */
function inspectStack(
  group: ReviewSetRepo[],
  branches: Awaited<ReturnType<ForgeClient['listBranches']>>,
  defaultTarget: string,
  onPhase?: (repo: ReviewSetRepo, phase: 'checking' | 'done' | 'error') => void,
): LocatedRepo[] {
  const ordered = [...group].sort((a, b) => a.position - b.position);
  const located: LocatedRepo[] = [];
  let previous: { branch: string; sha: string } | null = null;
  let skipped: string[] = [];

  for (const repo of ordered) {
    const found = repo.branch ? branches.find((branch) => branch.name === repo.branch) : null;
    if (!found) {
      onPhase?.(repo, 'error');
      located.push({ status: emptyRepoStatus(repo, `the branch ${repo.branch ?? '(none)'} does not exist`, defaultTarget), sha: null });
      if (repo.branch) skipped.push(repo.branch);
      continue;
    }
    const base = previous?.branch ?? defaultTarget;
    const note = skipped.length
      ? `${skipped.length === 1 ? 'Layer' : 'Layers'} ${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} missing, so this layer is compared against ${base}.`
      : undefined;
    skipped = [];
    const status: RepoStatus = {
      ...emptyRepoStatus(repo, undefined, base),
      accessible: true,
      matches: [found.name],
      branch: found.name,
      note,
    };
    located.push({ status, sha: found.sha });
    previous = { branch: found.name, sha: found.sha };
    onPhase?.(repo, 'done');
  }
  return located;
}

export { parseRepoList };
