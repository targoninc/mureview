import { afterAll, expect, test } from 'bun:test';
import { upsertConnection } from '../auth/identities';
import { decrypt, encrypt } from '../crypto';
import { db, type ForgeConnectionRow } from '../db';
import * as app from '../githubApp';
import { clientFor } from './index';
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

test('deleteBranch deletes the reference and tolerates a missing branch', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(null, { status: calls.length === 1 ? 204 : 422 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('token');
  await client.deleteBranch('acme/repo', 'feature/one');
  expect(calls[0].url).toBe('https://api.github.com/repos/acme/repo/git/refs/heads/feature/one');
  expect(calls[0].method).toBe('DELETE');
  await client.deleteBranch('acme/repo', 'feature/gone');
  expect(calls[1].method).toBe('DELETE');
});

test('pullRequestReview reads the acting user\'s latest decision', async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/user')) return Response.json({ login: 'me' });
    if (url.includes('/pulls/5/reviews')) {
      return Response.json([
        { id: 1, user: { login: 'someone' }, state: 'APPROVED' },
        { id: 2, user: { login: 'me' }, state: 'CHANGES_REQUESTED' },
      ]);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('token');
  expect(await client.pullRequestReview('acme/repo', '5')).toBe('reject');
});

test('reviewPullRequest approves, requests changes and withdraws', async () => {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    if (url.endsWith('/user')) return Response.json({ login: 'me' });
    if (url.includes('/reviews') && (init?.method ?? 'GET') === 'GET') {
      return Response.json([{ id: 7, user: { login: 'me' }, state: 'APPROVED' }]);
    }
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('token');
  await client.reviewPullRequest('acme/repo', '5', 'approve');
  const approve = calls.find((call) => call.url.includes('/pulls/5/reviews') && call.method === 'POST');
  expect(approve?.body).toContain('"event":"APPROVE"');

  await client.reviewPullRequest('acme/repo', '5', 'reject');
  const reject = calls.filter((call) => call.method === 'POST').pop();
  expect(reject?.body).toContain('"event":"REQUEST_CHANGES"');

  await client.reviewPullRequest('acme/repo', '5', 'waiting');
  const dismiss = calls.find((call) => call.url.includes('/reviews/7/dismissals'));
  expect(dismiss?.method).toBe('PUT');
});

test('pullRequestState reports merged, closed and changed branches', async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/pulls/5')) return Response.json({ state: 'closed', merged: true, head: { ref: 'other' }, base: { ref: 'main' } });
    if (url.endsWith('/pulls/6')) return Response.json({ state: 'closed', merged: false, head: { ref: 'topic' }, base: { ref: 'main' } });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('token');
  expect(await client.pullRequestState('acme/repo', '5')).toEqual({ state: 'merged', head: 'other', base: 'main' });
  expect(await client.pullRequestState('acme/repo', '6')).toEqual({ state: 'closed', head: 'topic', base: 'main' });
  expect(await client.pullRequestState('acme/repo', '7')).toBeNull();
});

test('the GitHub App signs JWTs and caches installation tokens', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  process.env.GITHUB_APP_WEBHOOK_SECRET = 'app-secret';
  const app = await import('../githubApp');
  app.resetGithubApp();
  const jwt = app.appJwt();
  const [header, payload] = jwt.split('.');
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { iss: string; exp: number };
  expect(claims.iss).toBe('12345');
  expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  expect(app.appJwt()).toBe(jwt);

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  }) as unknown as typeof fetch;
  expect(await app.installationToken('999')).toBe('installation-token');
  expect(await app.installationToken('999')).toBe('installation-token');
  expect(calls).toBe(1);
  expect(app.cachedInstallationToken('999')).toBe('installation-token');
  app.forgetInstallation('999');
  expect(app.cachedInstallationToken('999')).toBeNull();

  const { createHmac } = await import('node:crypto');
  const body = '{"action":"created"}';
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
  expect(app.verifyAppSignature(body, signature)).toBe(true);
  expect(app.verifyAppSignature(body, 'sha256=nope')).toBe(false);

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  app.resetGithubApp();
});

test('the app private key accepts escaped and base64 encodings', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const app = await import('../githubApp');
  for (const encoded of [privateKey, privateKey.replaceAll('\n', '\\n'), Buffer.from(privateKey).toString('base64')]) {
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY = encoded;
    app.resetGithubApp();
    expect(app.appJwt().split('.')).toHaveLength(3);
  }
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  app.resetGithubApp();
});

test('a repository the installation cannot see falls back to the account token', async () => {
  const calls: Array<{ url: string; authorization: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), authorization: headers.Authorization ?? '' });
    if (headers.Authorization === 'Bearer installation-token') return new Response('not found', { status: 404 });
    return Response.json([{ name: 'main', commit: { sha: 'abc123' } }]);
  }) as unknown as typeof fetch;

  const client = new GithubClient('installation-token', { refresh: async () => 'installation-token', fallback: () => 'account-token' });
  const branches = await client.listBranches('targoninc/lyda-backend');
  expect(branches.length).toBeGreaterThan(0);
  expect(calls).toHaveLength(2);
  expect(calls[0].authorization).toBe('Bearer installation-token');
  expect(calls[1].authorization).toBe('Bearer account-token');
});

test('a repository only the app installation can see uses its token', async () => {
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-real-key';
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  const app = await import('../githubApp');
  app.resetGithubApp();

  const calls: Array<{ url: string; authorization: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers.Authorization ?? '' });
    if (url.includes('/app/installations/77/access_tokens')) return Response.json({ token: 'org-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    if (url.includes('/repos/targoninc/lyda-internal-dashboard/installation')) return Response.json({ id: 77 });
    if (headers.Authorization === 'Bearer account-token') return new Response('not found', { status: 404 });
    if (headers.Authorization === 'Bearer org-token') return Response.json([{ name: 'main', commit: { sha: 'abc123' } }]);
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('account-token', {
    refresh: async () => 'account-token',
    fallback: () => 'account-token',
    installationForRepo: app.installationForRepo,
    installationToken: app.installationToken,
  });
  const branches = await client.listBranches('targoninc/lyda-internal-dashboard');
  expect(branches.map((branch) => branch.name)).toEqual(['main']);
  expect(calls.some((call) => call.authorization === 'Bearer org-token')).toBe(true);

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  app.resetGithubApp();
});

test('pullRequestReviews lists everyone\'s latest decision', async () => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/user')) return Response.json({ login: 'me' });
    if (url.includes('/pulls/5/reviews')) {
      return Response.json([
        { user: { login: 'me', avatar_url: 'https://a/me.png' }, state: 'COMMENTED' },
        { user: { login: 'me', avatar_url: 'https://a/me.png' }, state: 'APPROVED' },
        { user: { login: 'lena', avatar_url: 'https://a/lena.png' }, state: 'CHANGES_REQUESTED' },
      ]);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('token');
  const reviewers = await client.pullRequestReviews('acme/repo', '5');
  expect(reviewers).toEqual([
    { name: 'me', avatarUrl: 'https://a/me.png', vote: 'approve', you: true },
    { name: 'lena', avatarUrl: 'https://a/lena.png', vote: 'reject', you: false },
  ]);
});

test('ownPermission reads the account token, not an installation token', async () => {
  const authorizations: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    authorizations.push(String((init?.headers as Record<string, string>)?.['Authorization'] ?? ''));
    const url = String(input);
    if (url.endsWith('/repos/acme/app')) return Response.json({ permissions: { admin: false, maintain: false, push: true, pull: true } });
    if (url.endsWith('/repos/other/app')) return Response.json({ permissions: { pull: true } });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('installation-token', { refresh: async () => 'installation-token' }, 'own-token');
  expect(await client.ownPermission('acme/app')).toBe('write');
  expect(await client.ownPermission('other/app')).toBe('read');
  expect(await client.ownPermission('missing/app')).toBe('unknown');
  expect(authorizations).toEqual(['Bearer own-token', 'Bearer own-token', 'Bearer own-token']);

  expect(await new GithubClient('').ownPermission('acme/app')).toBe('unknown');
});

test('a connection with an app installation still checks permissions with the account token', async () => {
  let authorization = '';
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    authorization = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '');
    return Response.json({ permissions: { admin: true, push: true } });
  }) as unknown as typeof fetch;

  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key\n-----END RSA PRIVATE KEY-----';
  app.resetGithubApp();

  const connection: ForgeConnectionRow = {
    id: 9001,
    user_id: 1,
    kind: 'github',
    base_url: 'https://github.com',
    client_id: '',
    client_secret: '',
    access_token: encrypt('account-token'),
    refresh_token: '',
    login: 'owner',
    avatar_url: '',
    webhook_secret: null,
    installation_id: '42',
  };
  expect(await clientFor(connection).ownPermission?.('acme/repo')).toBe('write');
  expect(authorization).toBe('Bearer account-token');

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  app.resetGithubApp();
});

test('ownPermission refreshes the account token when it expired', async () => {
  const authorizations: string[] = [];
  let attempts = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    attempts++;
    authorizations.push(String((init?.headers as Record<string, string>)?.['Authorization'] ?? ''));
    if (attempts === 1) return new Response('bad credentials', { status: 401 });
    return Response.json({ permissions: { push: true } });
  }) as unknown as typeof fetch;

  const client = new GithubClient(
    'installation-token',
    { refresh: async () => 'installation-token', ownRefresh: async () => 'fresh-own' },
    'expired-own',
  );
  expect(await client.ownPermission('acme/app')).toBe('write');
  expect(authorizations).toEqual(['Bearer expired-own', 'Bearer fresh-own']);
});

test('an installation serving a repository reports its pull request permission', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  app.resetGithubApp();

  globalThis.fetch = (async (input: unknown) => {
    if (String(input).endsWith('/app/installations/42')) {
      return Response.json({ permissions: { contents: 'read', pull_requests: 'write' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const writer = new GithubClient('installation-token', { refresh: async () => 'installation-token' }, 'own-token', '42');
  expect(await writer.pullRequestPermission('acme/repo')).toBe('write');

  globalThis.fetch = (async (input: unknown) => {
    if (String(input).endsWith('/app/installations/7')) {
      return Response.json({ permissions: { contents: 'read', pull_requests: 'read' } });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  const reader = new GithubClient('installation-token', { refresh: async () => 'installation-token' }, 'own-token', '7');
  expect(await reader.pullRequestPermission('acme/repo')).toBe('read');

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  app.resetGithubApp();
});

test('listRepoSources groups installation repositories under their own source', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.GITHUB_APP_ID = '12345';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  app.resetGithubApp();
  app.forgetInstallation('77');

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === '/user/repos') {
      return Response.json([
        { full_name: 'loudar/app', private: true },
        { full_name: 'targoninc/shared', private: true },
      ]);
    }
    if (path === '/user/installations') {
      return Response.json({
        installations: [
          { id: 41, account: { login: 'loudar' } },
          { id: 77, account: { login: 'targoninc' } },
        ],
      });
    }
    if (path === '/app/installations/77/access_tokens') {
      return Response.json({ token: 'inst-77', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (path === '/installation/repositories') {
      return Response.json({ repositories: [{ full_name: 'targoninc/private-1', private: true }, { full_name: 'targoninc/shared', private: true }] });
    }
    console.error('github test miss:', String(input), Boolean(init));
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const client = new GithubClient('installation-token', { refresh: async () => 'installation-token' }, 'own-token', '41', 'loudar');
  const sources = await client.listRepoSources();
  expect(sources.map((source) => ({ key: source.key, account: source.account, repos: source.repos.map((repo) => repo.repo) }))).toEqual([
    { key: 'account', account: null, repos: ['loudar/app'] },
    { key: 'installation:77', account: 'targoninc', repos: ['targoninc/private-1', 'targoninc/shared'] },
  ]);

  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  app.resetGithubApp();
});
