import type { AvailableRepo, RepoSearchResponse, RepoSource } from '../shared/types';
import type { ForgeConnectionRow, UserRow } from './db';
import { Cache, cached, mapLimit } from './cache';
import { clientFor, hostOf, organizationOf } from './forges';
import { connectionsFor } from './auth/identities';
import { forgeErrorMessage } from './validate';

/**
 * Labels a connection so several accounts (or Azure DevOps organizations on the
 * same host) stay distinguishable.
 */
export function forgeSourceLabel(connection: ForgeConnectionRow): string {
  const host = hostOf(connection.base_url);
  const path = new URL(connection.base_url).pathname.replace(/^\/+|\/+$/g, '');
  const where = path ? `${host}/${path}` : host;
  return connection.login ? `${where} · ${connection.login}` : where;
}

function toSource(connection: ForgeConnectionRow): RepoSource {
  return {
    connectionId: connection.id,
    kind: connection.kind,
    host: hostOf(connection.base_url),
    org: organizationOf(connection.base_url),
    login: connection.login,
    label: forgeSourceLabel(connection),
  };
}

const freshTtlMs = 15 * 60_000;
const staleTtlMs = 24 * 60 * 60_000;

const repoCache = new Cache<AvailableRepo[]>(50, freshTtlMs);

async function loadConnectionRepos(connection: ForgeConnectionRow): Promise<AvailableRepo[]> {
  const client = clientFor(connection);
  const repos = await client.listRepos();
  return repos
    .map((repo) => ({
      connectionId: connection.id,
      repo: repo.repo,
      kind: connection.kind,
      host: client.host,
      org: organizationOf(connection.base_url),
      login: connection.login,
      sourceLabel: forgeSourceLabel(connection),
      private: repo.private,
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

export async function listAvailableRepos(user: UserRow, fresh = false): Promise<RepoSearchResponse> {
  const connections = connectionsFor(user.id);
  const results = await mapLimit(connections, 4, async (connection) => {
    const key = `connection:${connection.id}`;
    const label = forgeSourceLabel(connection);
    try {
      const repos = fresh ? await loadConnectionRepos(connection) : await cached(repoCache, key, () => loadConnectionRepos(connection));
      return { repos, error: null as null | { connectionId: number; message: string } };
    } catch (error) {
      // Serving the last successful list keeps the picker usable while the
      // forge is unreachable, rate limited or the token needs attention.
      const stale = repoCache.getStale(key, staleTtlMs);
      const detail = forgeErrorMessage(error);
      const message = `${label}: ${detail}${stale ? ' — showing the last successful repository list' : ''}`;
      return { repos: stale ?? ([] as AvailableRepo[]), error: { connectionId: connection.id, message } };
    }
  });

  return {
    repos: results.flatMap((result) => result.repos),
    sources: connections.map(toSource),
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}
