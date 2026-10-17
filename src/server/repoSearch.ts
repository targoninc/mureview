import type { AvailableRepo, RepoSearchResponse, RepoSource } from '../shared/types';
import type { ForgeConnectionRow, UserRow } from './db';
import { Cache, cached, mapLimit } from './cache';
import { clientFor, hostOf, organizationOf } from './forges';
import { connectionsFor } from './auth/identities';
import { HttpError } from './http';
import { forgeErrorMessage } from './validate';

/**
 * Labels a repository source so several accounts (or Azure DevOps organizations
 * on the same host) stay distinguishable.
 */
export function forgeSourceLabel(connection: ForgeConnectionRow, account?: string | null): string {
  const host = hostOf(connection.base_url);
  const path = new URL(connection.base_url).pathname.replace(/^\/+|\/+$/g, '');
  const where = path ? `${host}/${path}` : host;
  const login = account ?? connection.login;
  return login ? `${where} · ${login}` : where;
}

function sourceFor(connection: ForgeConnectionRow, key: string, account: string, host: string): RepoSource {
  return {
    id: `${connection.id}:${key}`,
    connectionId: connection.id,
    kind: connection.kind,
    host,
    org: organizationOf(connection.base_url),
    login: account,
    label: forgeSourceLabel(connection, account),
  };
}

interface ConnectionRepos {
  sources: RepoSource[];
  repos: AvailableRepo[];
}

const freshTtlMs = 15 * 60_000;
const staleTtlMs = 24 * 60 * 60_000;

const repoCache = new Cache<ConnectionRepos>(50, freshTtlMs);

/** The one source a connection offers when its repositories could not be read. */
function baseRepos(connection: ForgeConnectionRow): ConnectionRepos {
  return { sources: [sourceFor(connection, 'account', connection.login, hostOf(connection.base_url))], repos: [] };
}

async function loadConnectionRepos(connection: ForgeConnectionRow): Promise<ConnectionRepos> {
  const client = clientFor(connection);
  const listings = client.listRepoSources
    ? await client.listRepoSources()
    : [{ key: 'account', account: null, repos: await client.listRepos() }];
  const sources: RepoSource[] = [];
  const repos: AvailableRepo[] = [];
  for (const listing of listings) {
    const source = sourceFor(connection, listing.key, listing.account ?? connection.login, client.host);
    sources.push(source);
    for (const repo of listing.repos) {
      repos.push({
        sourceId: source.id,
        connectionId: connection.id,
        repo: repo.repo,
        kind: connection.kind,
        host: client.host,
        org: source.org,
        login: source.login,
        sourceLabel: source.label,
        private: repo.private,
      });
    }
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));
  return { sources, repos };
}

export async function listAvailableRepos(user: UserRow, fresh = false): Promise<RepoSearchResponse> {
  const connections = connectionsFor(user.id);
  const results = await mapLimit(connections, 4, async (connection) => {
    const key = `connection:${connection.id}`;
    const label = forgeSourceLabel(connection);
    try {
      const loaded = fresh ? await loadConnectionRepos(connection) : await cached(repoCache, key, () => loadConnectionRepos(connection));
      return { loaded, error: null as null | { connectionId: number; message: string } };
    } catch (error) {
      // Serving the last successful list keeps the picker usable while the
      // forge is unreachable, rate limited or the token needs attention.
      const stale = repoCache.getStale(key, staleTtlMs);
      const detail = forgeErrorMessage(error);
      const message = `${label}: ${detail}${stale ? ' — showing the last successful repository list' : ''}`;
      return { loaded: stale ?? baseRepos(connection), error: { connectionId: connection.id, message } };
    }
  });

  return {
    repos: results.flatMap((result) => result.loaded.repos),
    sources: results.flatMap((result) => result.loaded.sources),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}

/** The branch names of one repository, for the per-repo branch pickers. */
export async function listRepoBranches(user: UserRow, connectionId: number, repo: string): Promise<string[]> {
  const connection = connectionsFor(user.id).find((candidate) => candidate.id === connectionId);
  if (!connection) throw new HttpError(404, 'Connection not found');
  try {
    const branches = await clientFor(connection).listBranches(repo, {});
    return branches.map((branch) => branch.name);
  } catch (error) {
    throw new HttpError(400, `Could not list branches (${forgeErrorMessage(error)}).`);
  }
}
