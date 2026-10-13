import { createHash, randomBytes } from 'node:crypto';
import type { AuthProvider, ForgeConnectionInfo, IdentityInfo, MeResponse } from '../../shared/types';
import { Cache } from '../cache';
import { config } from '../config';
import { type ForgeConnectionRow, db } from '../db';
import { ForgeError, organizationOf } from '../forges';
import { AdoClient, normalizeAdoOrganization } from '../forges/ado';
import { getForgejoUser } from '../forges/forgejo';
import { getUser as getGithubUser } from '../forges/github';
import { HttpError, json, readJson } from '../http';
import type { Ctx } from '../router';
import {
  type ConnectionInput,
  type IdentityProfile,
  addIdentity,
  connectionById,
  connectionsFor,
  findUserByIdentity,
  identitiesFor,
  loginOrCreate,
  mergeUsers,
  upsertConnection,
  userById,
} from './identities';
import { type OAuthMode, type PendingAuth, createState, takeState } from './oauthState';
import { endSession, publicUser, requireUser, startSession } from './session';

export function enabledProviders(): AuthProvider[] {
  const providers: AuthProvider[] = ['email', 'forgejo', 'atproto'];
  if (config.githubClientId && config.githubClientSecret) providers.unshift('github');
  if (config.entraClientId && config.entraClientSecret) providers.unshift('entra');
  return providers;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function appUrl(path = '/'): string {
  return `${config.baseUrl}${config.basePath}${path}`;
}

function forgejoRedirectUri(): string {
  return `${config.baseUrl}/api/auth/callback/forgejo`;
}

function githubRedirectUri(): string {
  return config.githubRedirectUri || `${config.baseUrl}/api/auth/callback/github`;
}

export function normalizeForgeHost(input: string): string {
  let value = input.trim();
  if (!value) throw new HttpError(400, 'Enter the Forgejo instance URL.');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'That does not look like a valid URL.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function completeAuth(profile: IdentityProfile, connection: ConnectionInput | null, pending: PendingAuth): Response {
  if (pending.mode === 'connect') {
    const current = pending.userId ? userById(pending.userId) : null;
    if (!current) throw new HttpError(400, 'Your session expired before the connection finished. Sign in and try again.');
    const existing = findUserByIdentity(profile.provider, profile.subject);
    if (existing && existing.id !== current.id) {
      mergeUsers(existing.id, current.id);
    } else if (!existing) {
      addIdentity(current.id, profile);
    }
    if (connection) upsertConnection(current.id, connection);
    return redirect(appUrl('/settings'), startSession(current.id));
  }

  const { user } = loginOrCreate(profile);
  if (connection) upsertConnection(user.id, connection);
  return redirect(appUrl('/'), startSession(user.id));
}

// --- GitHub -----------------------------------------------------------------

const githubCredentialsCache = new Cache<boolean>(1, 60 * 60_000);

/**
 * GitHub shows a bare 404 for unknown client ids, which is impossible to
 * explain to users. Probe the token endpoint once per hour instead: with a
 * valid client id/secret a bogus code returns bad_verification_code.
 */
async function githubCredentialsValid(): Promise<boolean> {
  if (githubCredentialsCache.get('github') !== undefined) return true;
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code: 'mureview-credentials-check' }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (body.error === undefined) return true; // unexpected response, don't block sign-in
  // A bogus code against real credentials answers bad_verification_code; unknown
  // client ids answer "Not Found" (what users otherwise see as GitHub's 404).
  const valid = body.error === 'bad_verification_code';
  if (valid) githubCredentialsCache.set('github', true);
  return valid;
}

export async function githubLoginStart(ctx: Ctx): Promise<Response> {
  if (!config.githubClientId || !config.githubClientSecret) {
    return redirectWithError('GitHub sign-in is not configured on this server.');
  }
  if (!(await githubCredentialsValid())) {
    return redirectWithError(
      'The configured GitHub OAuth app credentials were rejected by GitHub. Check GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
    );
  }
  const mode: OAuthMode = ctx.url.searchParams.get('mode') === 'connect' ? 'connect' : 'login';
  const user = mode === 'connect' ? requireUser(ctx) : null;
  const state = createState({ provider: 'github', mode, userId: user?.id });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubClientId);
  url.searchParams.set('redirect_uri', githubRedirectUri());
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  return redirect(url.toString());
}

export function redirectWithError(message: string, path = '/'): Response {
  return redirect(`${config.baseUrl}${config.basePath}${path}?authError=${encodeURIComponent(message)}`);
}

export function handleAuthError(error: unknown, path = '/'): Response {
  if (error instanceof HttpError) return redirectWithError(error.message, path);
  throw error;
}

export async function githubCallback(ctx: Ctx): Promise<Response> {
  try {
    return await githubCallbackInner(ctx);
  } catch (error) {
    return handleAuthError(error);
  }
}

async function githubCallbackInner(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  if (!code || !state) throw new HttpError(400, 'GitHub did not return a code.');
  let pending: PendingAuth;
  try {
    pending = takeState(state, 'github');
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: githubRedirectUri(),
    }),
  });
  const body = (await response.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) throw new HttpError(400, body.error_description ?? 'GitHub did not return an access token.');

  const ghUser = await getGithubUser(body.access_token);
  const profile: IdentityProfile = {
    provider: 'github',
    subject: String(ghUser.id),
    displayName: ghUser.login,
    avatarUrl: ghUser.avatar_url,
  };
  const connection: ConnectionInput = {
    kind: 'github',
    baseUrl: 'https://github.com',
    accessToken: body.access_token,
    login: ghUser.login,
    avatarUrl: ghUser.avatar_url,
  };
  return completeAuth(profile, connection, pending);
}

// --- Entra ID ----------------------------------------------------------------

function entraRedirectUri(): string {
  return `${config.baseUrl}/api/auth/callback/entra`;
}

function entraAuthority(): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.entraTenant)}`;
}

const entraScopes = 'openid profile email User.Read';

export function entraLoginStart(ctx: Ctx): Response {
  if (!config.entraClientId || !config.entraClientSecret) {
    return redirectWithError('Entra ID sign-in is not configured on this server.');
  }
  const mode: OAuthMode = ctx.url.searchParams.get('mode') === 'connect' ? 'connect' : 'login';
  const user = mode === 'connect' ? requireUser(ctx) : null;
  const state = createState({ provider: 'entra', mode, userId: user?.id });

  const url = new URL(`${entraAuthority()}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', config.entraClientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', entraRedirectUri());
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', entraScopes);
  url.searchParams.set('state', state);
  return redirect(url.toString());
}

export async function entraCallback(ctx: Ctx): Promise<Response> {
  try {
    return await entraCallbackInner(ctx);
  } catch (error) {
    return handleAuthError(error);
  }
}

interface EntraIdToken {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
}

async function entraCallbackInner(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  if (!code || !state) throw new HttpError(400, 'Entra ID did not return a code.');
  let pending: PendingAuth;
  try {
    pending = takeState(state, 'entra');
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }

  const response = await fetch(`${entraAuthority()}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.entraClientId,
      client_secret: config.entraClientSecret,
      code,
      redirect_uri: entraRedirectUri(),
      scope: entraScopes,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { id_token?: string; access_token?: string; error_description?: string };
  if (!body.id_token) throw new HttpError(400, body.error_description ?? 'Entra ID did not return an id token.');

  // The token came straight from the token endpoint over TLS, so the payload
  // can be read without verifying the signature again.
  let claims: EntraIdToken;
  try {
    claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as EntraIdToken;
  } catch {
    throw new HttpError(400, 'Entra ID returned an unreadable id token.');
  }
  if (!claims.sub) throw new HttpError(400, 'Entra ID did not return an account identifier.');

  const profile: IdentityProfile = {
    provider: 'entra',
    subject: claims.sub,
    displayName: claims.name || claims.preferred_username || claims.email || 'Microsoft account',
    avatarUrl: await entraAvatar(body.access_token),
  };
  return completeAuth(profile, null, pending);
}

/** The account photo from Microsoft Graph, as a data URI (best effort). */
async function entraAvatar(accessToken?: string): Promise<string> {
  if (!accessToken) return '';
  try {
    const response = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return '';
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return '';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 200_000) return '';
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } catch {
    return '';
  }
}

// --- Forgejo ----------------------------------------------------------------

export async function forgejoLoginStart(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx.req);
  const baseUrl = normalizeForgeHost(typeof form.host === 'string' ? form.host : '');
  const clientId = typeof form.clientId === 'string' ? form.clientId.trim() : '';
  const clientSecret = typeof form.clientSecret === 'string' ? form.clientSecret.trim() : '';
  if (!clientId || !clientSecret) throw new HttpError(400, 'Enter the OAuth2 application client id and secret.');
  const mode: OAuthMode = form.mode === 'connect' ? 'connect' : 'login';
  const user = mode === 'connect' ? requireUser(ctx) : null;

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = createState({ provider: 'forgejo', mode, userId: user?.id, payload: { baseUrl, clientId, clientSecret, verifier } });
  const url = new URL(`${baseUrl}/login/oauth/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', forgejoRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return redirect(url.toString());
}

export async function forgejoCallback(ctx: Ctx): Promise<Response> {
  try {
    return await forgejoCallbackInner(ctx);
  } catch (error) {
    return handleAuthError(error);
  }
}

async function forgejoCallbackInner(ctx: Ctx): Promise<Response> {
  const code = ctx.url.searchParams.get('code');
  const state = ctx.url.searchParams.get('state');
  if (!code || !state) throw new HttpError(400, 'The forge did not return a code.');
  let pending: PendingAuth;
  try {
    pending = takeState(state, 'forgejo');
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const { baseUrl, clientId, clientSecret, verifier } = pending.payload;

  const tokenResponse = await fetch(`${baseUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: forgejoRedirectUri(),
      code_verifier: verifier,
    }),
  });
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!tokenBody.access_token) {
    throw new HttpError(400, tokenBody.error_description ?? tokenBody.error ?? 'The forge did not return an access token.');
  }

  let forgeUser: { id: number; login: string; full_name: string; avatar_url: string };
  try {
    forgeUser = await getForgejoUser(baseUrl, tokenBody.access_token);
  } catch (error) {
    throw new HttpError(400, `Could not read your profile from ${baseUrl}: ${(error as ForgeError).message}`);
  }

  const profile: IdentityProfile = {
    provider: 'forgejo',
    subject: `${baseUrl}#${forgeUser.id}`,
    displayName: forgeUser.login,
    avatarUrl: absoluteAvatar(baseUrl, forgeUser.avatar_url),
  };
  const connection: ConnectionInput = {
    kind: 'forgejo',
    baseUrl,
    clientId,
    clientSecret,
    accessToken: tokenBody.access_token,
    login: forgeUser.login,
    avatarUrl: absoluteAvatar(baseUrl, forgeUser.avatar_url),
  };
  return completeAuth(profile, connection, pending);
}

function absoluteAvatar(baseUrl: string, avatar: string): string {
  if (!avatar) return '';
  return avatar.startsWith('http') ? avatar : `${baseUrl}${avatar}`;
}

async function readForm(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

// --- Email + password -------------------------------------------------------

export async function register(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown; name?: unknown }>(ctx.req);
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  const password = requirePassword(typeof body.password === 'string' ? body.password : '');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : email.split('@')[0];

  if (findUserByIdentity('email', email)) throw new HttpError(400, 'An account with this email already exists. Sign in instead.');

  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
  const profile: IdentityProfile = { provider: 'email', subject: email, displayName: name, avatarUrl: '', passwordHash };
  const { user } = loginOrCreate(profile);
  return json({ user: publicUser(user) }, 201, { 'Set-Cookie': startSession(user.id) });
}

export async function passwordLogin(ctx: Ctx): Promise<Response> {
  const body = await readJson<{ email?: unknown; password?: unknown }>(ctx.req);
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  const password = typeof body.password === 'string' ? body.password : '';

  const identity = db
    .query<{ id: number; user_id: number; password_hash: string | null }, [string, string]>(
      'SELECT * FROM identities WHERE provider = ? AND subject = ?',
    )
    .get('email', email);
  if (!identity?.password_hash || !(await Bun.password.verify(password, identity.password_hash))) {
    throw new HttpError(401, 'Wrong email or password.');
  }
  const user = userById(identity.user_id);
  if (!user) throw new HttpError(401, 'Wrong email or password.');
  return json({ user: publicUser(user) }, 200, { 'Set-Cookie': startSession(user.id) });
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.');
  return email;
}

function requirePassword(value: string): string {
  if (value.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  return value;
}

// --- Session, connections, me ----------------------------------------------

export function logout(ctx: Ctx): Response {
  return json({ ok: true }, 200, { 'Set-Cookie': endSession(ctx.req) });
}

function manageUrlFor(connection: ForgeConnectionRow): string | null {
  if (connection.kind === 'github') {
    return config.githubClientId ? `https://github.com/settings/connections/applications/${config.githubClientId}` : null;
  }
  if (connection.kind === 'forgejo') return `${connection.base_url}/user/settings/applications`;
  if (connection.kind === 'ado') return `${connection.base_url}/_usersSettings/tokens`;
  return null;
}

function connectionInfo(connection: ForgeConnectionRow): ForgeConnectionInfo {
  const host = new URL(connection.base_url).host;
  return {
    id: connection.id,
    kind: connection.kind,
    baseUrl: connection.base_url,
    host,
    org: organizationOf(connection.base_url),
    login: connection.login,
    avatarUrl: connection.avatar_url,
    manageUrl: manageUrlFor(connection),
  };
}

export function me(ctx: Ctx): Response {
  const user = ctx.user;
  const payload: MeResponse = {
    user: user ? publicUser(user) : null,
    identities: user ? identitiesFor(user.id).map((row): IdentityInfo => ({ id: row.id, provider: row.provider as IdentityInfo['provider'], displayName: row.display_name })) : [],
    connections: user ? connectionsFor(user.id).map(connectionInfo) : [],
    providers: enabledProviders(),
    githubOAuthAppUrl: config.githubClientId ? `https://github.com/settings/connections/applications/${config.githubClientId}` : null,
  };
  return json(payload);
}

export async function connectAdo(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const body = await readJson<{ organization?: unknown; token?: unknown }>(ctx.req);
  const organization = typeof body.organization === 'string' ? body.organization.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!organization || !token) throw new HttpError(400, 'Organization and personal access token are required.');

  let baseUrl: string;
  try {
    baseUrl = normalizeAdoOrganization(organization);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }

  const client = new AdoClient(baseUrl, token);
  let account: { id: string; name: string; avatarUrl: string };
  try {
    account = await client.currentUser();
  } catch (error) {
    throw new HttpError(
      400,
      `Azure DevOps rejected the personal access token: ${(error as Error).message}. Check that the token is not expired, has the ` +
        `"Project and Team (read)" and "Code (read & write)" scopes, and is scoped to this organization (or "all accessible organizations").`,
    );
  }
  try {
    await client.ensureOrg();
  } catch (error) {
    throw new HttpError(400, `Could not reach ${baseUrl}: ${(error as Error).message}`);
  }

  const connection = upsertConnection(user.id, {
    kind: 'ado',
    baseUrl,
    accessToken: token,
    login: account.name,
    avatarUrl: account.avatarUrl,
  });
  return json({ connection: connectionInfo(connection) }, 201);
}

/**
 * Removes everything mureview stored for the account: review sets and, via
 * cascades, their repositories, pull request tracking, comments and reviewed
 * files. Nothing on the forges themselves is touched, and the account keeps
 * its sign-in methods and forge connections.
 */
export function deleteAccountData(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const result = db.run('DELETE FROM review_sets WHERE owner_id = ?', [user.id]);
  return json({ ok: true, reviewSets: result.changes });
}

export function listConnections(ctx: Ctx): Response {
  const user = requireUser(ctx);
  return json({ connections: connectionsFor(user.id).map(connectionInfo) });
}

export function deleteConnection(ctx: Ctx): Response {
  const user = requireUser(ctx);
  const connection = connectionById(user.id, Number(ctx.params.id));
  if (!connection) throw new HttpError(404, 'Connection not found');
  const used = db
    .query<{ count: number }, [number]>('SELECT COUNT(*) AS count FROM review_set_repos WHERE connection_id = ?')
    .get(connection.id);
  if (used && used.count > 0) {
    throw new HttpError(400, `This connection is used by ${used.count} review set ${used.count === 1 ? 'repository' : 'repositories'}. Remove them first.`);
  }
  db.run('DELETE FROM forge_connections WHERE id = ?', [connection.id]);
  return json({ ok: true });
}
