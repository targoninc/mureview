import { afterAll, expect, test } from 'bun:test';

// Must be set before anything imports the database.
process.env.DATABASE_PATH = `/tmp/opencode/github-forge-test-${process.pid}.db`;
process.env.SESSION_SECRET = 'test-secret';

const { GithubClient, exchangeGithubRefreshToken, refreshGithubToken } = await import('./github');

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
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
  const { upsertConnection } = await import('../auth/identities');
  const { db } = await import('../db');
  const { decrypt } = await import('../crypto');

  const inserted = db.run("INSERT INTO users (name, avatar_url) VALUES ('tester', '')");
  const connection = upsertConnection(Number(inserted.lastInsertRowid), {
    kind: 'github',
    baseUrl: 'https://github.com',
    accessToken: 'expired',
    refreshToken: 'refresh-1',
    login: 'tester',
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
  const { upsertConnection } = await import('../auth/identities');
  const { db } = await import('../db');
  const { userById } = await import('../auth/identities');
  const userId = db.query<{ id: number }, []>('SELECT id FROM users LIMIT 1').get()!.id;
  const connection = upsertConnection(userId, {
    kind: 'github',
    baseUrl: 'https://github.com/other',
    accessToken: 'expired',
    login: 'tester',
  });
  expect(userById(userId)).toBeTruthy();
  await expect(refreshGithubToken(connection.id)).rejects.toThrow('reconnect GitHub');
});
