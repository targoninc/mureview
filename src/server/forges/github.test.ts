import { afterAll, expect, test } from 'bun:test';
import { upsertConnection } from '../auth/identities';
import { decrypt } from '../crypto';
import { db } from '../db';
import { GithubClient, exchangeGithubRefreshToken, refreshGithubToken } from './github';

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

test('the v10 migration keeps connections and their review set repositories', () => {
  const connection = db.query<{ login: string }, [string]>('SELECT login FROM forge_connections WHERE login = ?').get('account-a');
  expect(connection?.login).toBe('account-a');
  const repo = db.query<{ repo: string }, []>('SELECT repo FROM review_set_repos').get();
  expect(repo?.repo).toBe('acme/repo');
});

test('a second account on the same forge becomes its own connection', () => {
  const second = upsertConnection(1, {
    kind: 'github',
    baseUrl: 'https://github.com',
    accessToken: 'token-b',
    refreshToken: 'refresh-b',
    login: 'account-b',
  });
  expect(second.login).toBe('account-b');
  const count = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM forge_connections WHERE kind = 'github' AND base_url = 'https://github.com'")
    .get();
  expect(count?.count).toBe(2);
});

test('reconnecting the same account updates its connection', () => {
  const first = upsertConnection(1, {
    kind: 'github',
    baseUrl: 'https://github.com',
    accessToken: 'new-token',
    login: 'account-a',
  });
  expect(first.login).toBe('account-a');
  expect(decrypt(first.access_token)).toBe('new-token');
  const count = db
    .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM forge_connections WHERE kind = 'github' AND base_url = 'https://github.com'")
    .get();
  expect(count?.count).toBe(2);
});

test('exchangeGithubRefreshToken exchanges and rotates the refresh token', async () => {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh' });
  }) as unknown as typeof fetch;

  const tokens = await exchangeGithubRefreshToken('old-refresh');
  expect(tokens).toEqual({ accessToken: 'new-access', refreshToken: 'new-refresh' });
  expect(calls[0].url).toContain('github.com/login/oauth/access_token');
  expect(calls[0].body).toContain('"grant_type":"refresh_token"');
  expect(calls[0].body).toContain('old-refresh');
});

test('exchangeGithubRefreshToken surfaces rejected refresh tokens', async () => {
  globalThis.fetch = (async () =>
    Response.json({ error: 'bad_refresh_token', error_description: 'The refresh token is invalid' })) as unknown as typeof fetch;
  await expect(exchangeGithubRefreshToken('nope')).rejects.toThrow('The refresh token is invalid');
});

test('GithubClient refreshes an expired token and retries once', async () => {
  let refreshed = 0;
  const seen: unknown[] = [];
  let first = true;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    if (first) {
      first = false;
      return new Response('{}', { status: 401 });
    }
    return Response.json({ full_name: 'acme/repo' });
  }) as unknown as typeof fetch;

  const client = new GithubClient('expired-token', {
    refresh: async () => {
      refreshed++;
      return 'fresh-token';
    },
  });
  await client.ensureRepo('acme/repo', { fresh: true });
  expect(refreshed).toBe(1);
  expect(seen).toEqual(['Bearer expired-token', 'Bearer fresh-token']);
});

test('GithubClient surfaces a 401 when there is nothing to refresh with', async () => {
  globalThis.fetch = (async () => new Response('{"message":"Bad credentials"}', { status: 401 })) as unknown as typeof fetch;
  const client = new GithubClient('dead-token');
  await expect(client.ensureRepo('acme/repo', { fresh: true })).rejects.toThrow('Bad credentials');
});

test('refreshGithubToken persists the rotated tokens', async () => {
  const connection = upsertConnection(1, {
    kind: 'github',
    baseUrl: 'https://github.com/refresh',
    accessToken: 'expired',
    refreshToken: 'refresh-1',
    login: 'refresher',
  });

  globalThis.fetch = (async () => Response.json({ access_token: 'fresh', refresh_token: 'refresh-2' })) as unknown as typeof fetch;
  const token = await refreshGithubToken(connection.id);
  expect(token).toBe('fresh');

  const row = db
    .query<{ access_token: string; refresh_token: string }, [number]>('SELECT * FROM forge_connections WHERE id = ?')
    .get(connection.id)!;
  expect(decrypt(row.access_token)).toBe('fresh');
  expect(decrypt(row.refresh_token)).toBe('refresh-2');
});

test('refreshGithubToken fails cleanly without a stored refresh token', async () => {
  const connection = upsertConnection(1, {
    kind: 'github',
    baseUrl: 'https://github.com/no-refresh',
    accessToken: 'expired',
    login: 'no-refresh',
  });
  await expect(refreshGithubToken(connection.id)).rejects.toThrow('reconnect GitHub');
});
