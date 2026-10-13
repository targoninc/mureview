import type { AvailableRepo, RepoSearchResponse } from '../shared/types';
import type { ForgeConnectionRow, UserRow } from './db';
import { Cache, cached, mapLimit } from './cache';
import { clientFor, hostOf } from './forges';
import { connectionsFor } from './auth/identities';
import { forgeErrorMessage } from './validate';

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
      login: connection.login,
      private: repo.private,
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}

export async function listAvailableRepos(user: UserRow, fresh = false): Promise<RepoSearchResponse> {
  const connections = connectionsFor(user.id);
  const results = await mapLimit(connections, 4, async (connection) => {
    const key = `connection:${connection.id}`;
    const label = `${hostOf(connection.base_url)}/${connection.login}`;
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
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
  };
}
