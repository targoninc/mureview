import type { User } from '../shared/types';
import { constants, config } from './config';
import { decrypt, encrypt, randomToken } from './crypto';
import { db } from './db';
import { getUser as ghGetUser } from './github';
import { HttpError, clearCookie, json, parseCookies, setCookie } from './http';
import type { Ctx } from './router';

export interface UserRow {
  id: number;
  github_id: number;
  login: string;
  name: string;
  avatar_url: string;
  token: string;
}

export function publicUser(row: UserRow): User {
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url };
}

export function userToken(row: UserRow): string {
  return decrypt(row.token);
}

export function getSessionUser(req: Request): UserRow | null {
  const token = parseCookies(req.headers.get('cookie'))[constants.sessionCookie];
  if (!token) return null;
  const row = db
    .query<UserRow, [string]>(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')`)
    .get(token);
  return row ?? null;
}

export function requireUser(ctx: Ctx): UserRow {
  if (!ctx.user) throw new HttpError(401, 'Sign in with GitHub to continue.');
  return ctx.user;
}

const cookiePath = () => config.basePath || '/';
const cookieBase = () => ({ path: cookiePath(), httpOnly: true, secure: config.baseUrl.startsWith('https') });

function redirectUri(): string {
  return `${config.baseUrl}/api/auth/callback`;
}

export function handleLogin(): Response {
  if (!config.githubClientId || !config.githubClientSecret) {
    throw new HttpError(500, 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
  }
  const state = randomToken(16);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubClientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      'Set-Cookie': setCookie(constants.stateCookie, state, { ...cookieBase(), maxAge: 600 }),
    },
  });
}

export async function handleCallback(ctx: Ctx): Promise<Response> {
  const state = parseCookies(ctx.req.headers.get('cookie'))[constants.stateCookie];
  const code = ctx.url.searchParams.get('code');
  const givenState = ctx.url.searchParams.get('state');
  if (!state || !givenState || state !== givenState || !code) {
    throw new HttpError(400, 'OAuth state mismatch or missing code. Please try signing in again.');
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const tokenBody = (await tokenRes.json()) as { access_token?: string; error_description?: string };
  if (!tokenBody.access_token) {
    throw new HttpError(400, tokenBody.error_description ?? 'GitHub did not return an access token.');
  }

  const ghUser = await ghGetUser(tokenBody.access_token);
  db.run(
    `INSERT INTO users (github_id, login, name, avatar_url, token) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url, token = excluded.token`,
    [ghUser.id, ghUser.login, ghUser.name ?? '', ghUser.avatar_url, encrypt(tokenBody.access_token)],
  );
  const row = db.query<{ id: number }, [number]>('SELECT id FROM users WHERE github_id = ?').get(ghUser.id)!;

  const session = randomToken();
  db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`, [
    session,
    row.id,
    `+${constants.sessionDays} days`,
  ]);

  const headers = new Headers({ Location: `${config.baseUrl}${config.basePath}/` });
  headers.append('Set-Cookie', setCookie(constants.sessionCookie, session, { ...cookieBase(), maxAge: constants.sessionDays * 86400 }));
  headers.append('Set-Cookie', clearCookie(constants.stateCookie, cookiePath()));
  return new Response(null, { status: 302, headers });
}

export function handleLogout(ctx: Ctx): Response {
  const session = parseCookies(ctx.req.headers.get('cookie'))[constants.sessionCookie];
  if (session) db.run('DELETE FROM sessions WHERE token = ?', [session]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(constants.sessionCookie, cookiePath()) });
}

export function handleMe(ctx: Ctx): Response {
  return json({
    user: ctx.user ? publicUser(ctx.user) : null,
    oauthAppUrl: config.githubClientId
      ? `https://github.com/settings/connections/applications/${config.githubClientId}`
      : null,
  });
}
