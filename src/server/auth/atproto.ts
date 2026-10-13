import { resolveTxt } from 'node:dns/promises';
import { AtprotoHandleResolver } from '@atproto-labs/handle-resolver';
import { NodeOAuthClient } from '@atproto/oauth-client-node';
import { Agent } from '@atproto/api';
import { config } from '../config';
import { decrypt, encrypt } from '../crypto';
import { HttpError, clearCookie, parseCookies, setCookie } from '../http';
import type { Ctx } from '../router';
import type { OAuthMode } from './oauthState';
import { completeAuth, handleAuthError } from './providers';
import { cookiePath, isSecure, requireUser } from './session';

class MemoryStore<T> {
  private values = new Map<string, T>();

  async get(key: string): Promise<T | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export const atprotoMetadata = {
  client_id: `${config.baseUrl}/oauth-client-metadata.json`,
  client_name: 'mureview',
  client_uri: config.baseUrl,
  redirect_uris: [`${config.baseUrl}/api/auth/callback/atproto`],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'atproto',
  dpop_bound_access_tokens: true,
  token_endpoint_auth_method: 'none',
  application_type: 'web',
};

async function resolveHandleTxt(hostname: string): Promise<string[] | null> {
  try {
    const records = await resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EBADNAME') throw error;
    return null;
  }
}

const locks = new Map<string, Promise<unknown>>();

function requestLock<T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> {
  const previous = locks.get(name) ?? Promise.resolve();
  const next = previous.then(
    () => fn(),
    () => fn(),
  );
  locks.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}

let client: NodeOAuthClient | null = null;

function atprotoClient(): NodeOAuthClient {
  if (!client) {
    client = new NodeOAuthClient({
      clientMetadata: atprotoMetadata as ConstructorParameters<typeof NodeOAuthClient>[0]['clientMetadata'],
      stateStore: new MemoryStore(),
      sessionStore: new MemoryStore(),
      requestLock,
      // The default handle resolver wraps fetch in the Node SSRF dispatcher,
      // which needs process.versions.undici and therefore fails on Bun. Use the
      // plain resolver with the global fetch instead.
      handleResolver: new AtprotoHandleResolver({ fetch: globalThis.fetch, resolveTxt: resolveHandleTxt }),
      fetch: globalThis.fetch as unknown as NonNullable<ConstructorParameters<typeof NodeOAuthClient>[0]['fetch']>,
    });
  }
  return client;
}

const pendingCookie = 'mureview_atproto_pending';

export async function atprotoLoginStart(ctx: Ctx): Promise<Response> {
  const handle = (ctx.url.searchParams.get('handle') ?? '').trim().replace(/^@/, '');
  if (!handle) throw new HttpError(400, 'Enter your atproto handle, for example alice.bsky.social.');
  const mode: OAuthMode = ctx.url.searchParams.get('mode') === 'connect' ? 'connect' : 'login';
  const userId = mode === 'connect' ? requireUser(ctx).id : undefined;

  let url: URL;
  try {
    url = new URL(await atprotoClient().authorize(handle));
  } catch (error) {
    throw new HttpError(400, `Could not start atproto sign-in: ${(error as Error).message}`);
  }

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    'Set-Cookie',
    setCookie(pendingCookie, encrypt(JSON.stringify({ mode, userId, handle })), {
      path: cookiePath(),
      httpOnly: true,
      secure: isSecure(),
      maxAge: 900,
    }),
  );
  return new Response(null, { status: 302, headers });
}

interface PendingAtproto {
  mode: OAuthMode;
  userId?: number;
  handle?: string;
}

function pendingAuth(ctx: Ctx): PendingAtproto | null {
  const raw = parseCookies(ctx.req.headers.get('cookie'))[pendingCookie];
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw)) as PendingAtproto;
  } catch {
    return null;
  }
}

export async function atprotoCallback(ctx: Ctx): Promise<Response> {
  const pending = pendingAuth(ctx);
  try {
    return await atprotoCallbackInner(ctx, pending);
  } catch (error) {
    return handleAuthError(error, pending?.mode === 'connect' ? '/settings' : '/');
  }
}

async function atprotoCallbackInner(ctx: Ctx, pending: PendingAtproto | null): Promise<Response> {
  if (!ctx.url.searchParams.get('code') || !ctx.url.searchParams.get('state')) {
    throw new HttpError(400, 'The atproto provider did not return a code.');
  }
  if (!pending) throw new HttpError(400, 'This atproto sign-in expired. Please start again.');

  const target = pending.mode === 'connect' ? '/settings' : '/';
  try {
    const { session } = await atprotoClient().callback(ctx.url.searchParams);
    const did = session.did;

    // The profile lookup goes through the PDS's AppView proxy, which is not
    // always available; fall back to the handle that was typed in.
    let displayName = pending.handle || did;
    let avatarUrl = '';
    try {
      const agent = new Agent(session);
      const profile = await agent.getProfile({ actor: did });
      displayName = profile.data.handle || displayName;
      avatarUrl = profile.data.avatar ?? '';
    } catch (error) {
      console.error('atproto profile lookup failed, continuing without it:', error);
    }

    const response = completeAuth(
      { provider: 'atproto', subject: did, displayName, avatarUrl },
      null,
      { provider: 'atproto', mode: pending.mode, userId: pending.userId ?? null, payload: {} },
    );
    response.headers.append('Set-Cookie', clearCookie(pendingCookie, cookiePath()));
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = `atproto ${pending.mode === 'connect' ? 'connection' : 'sign-in'} failed: ${(error as Error).message}`;
    console.error(message, error);
    throw new HttpError(400, message);
  }
}
