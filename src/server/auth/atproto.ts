import { Agent } from '@atproto/api';
import { atprotoClient } from '../atproto/client';
import { tangledAvatar, tangledDid, tangledHandleFor } from '../forges/tangled';
import { config } from '../config';
import { decrypt, encrypt } from '../crypto';
import { HttpError, clearCookie, parseCookies, setCookie } from '../http';
import type { Ctx } from '../router';
import type { OAuthMode } from './oauthState';
import { completeAuth, handleAuthError } from './providers';
import type { ConnectionInput } from './identities';
import { cookiePath, isSecure, requireUser } from './session';

export { atprotoMetadata } from '../atproto/client';

const pendingCookie = 'mureview_atproto_pending';

export async function atprotoLoginStart(ctx: Ctx): Promise<Response> {
  const handle = (ctx.url.searchParams.get('handle') ?? '').trim().replace(/^@/, '');
  if (!handle) throw new HttpError(400, 'Enter your atproto handle, for example alice.bsky.social.');
  const mode: OAuthMode = ctx.url.searchParams.get('mode') === 'connect' ? 'connect' : 'login';
  const userId = mode === 'connect' ? requireUser(ctx).id : undefined;
  // Connecting Tangled is the same authorization; the callback then also
  // creates the Tangled connection for the account that signed in.
  const tangled = ctx.url.searchParams.get('tangled') === '1';

  let url: URL;
  try {
    url = new URL(await atprotoClient().authorize(handle));
  } catch (error) {
    throw new HttpError(400, `Could not start atproto sign-in: ${(error as Error).message}`);
  }

  const headers = new Headers({ Location: url.toString() });
  headers.append(
    'Set-Cookie',
    setCookie(pendingCookie, encrypt(JSON.stringify({ mode, userId, handle, tangled })), {
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
  tangled?: boolean;
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
    return handleAuthError(ctx, error);
  }
}

async function atprotoCallbackInner(ctx: Ctx, pending: PendingAtproto | null): Promise<Response> {
  if (!ctx.url.searchParams.get('code') || !ctx.url.searchParams.get('state')) {
    throw new HttpError(400, 'The atproto provider did not return a code.');
  }
  if (!pending) throw new HttpError(400, 'This atproto sign-in expired. Please start again.');

  try {
    const { session } = await atprotoClient().callback(ctx.url.searchParams);
    const did = session.did;

    // The profile lookup goes through the PDS's AppView proxy, which is not
    // always available (and needs the AppView scope); fall back to the handle
    // that was typed in.
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

    // A Tangled connection writes through this account's session, so it is
    // created in the same flow; its label must be the account that signed in.
    let connection: ConnectionInput | null = null;
    if (pending.tangled && pending.mode === 'connect') {
      const resolved = await tangledDid(pending.handle ?? '');
      const handle = resolved === did ? (pending.handle ?? displayName) : await tangledHandleFor(did);
      connection = {
        kind: 'tangled',
        baseUrl: 'https://tangled.org',
        accessToken: did,
        login: handle,
        avatarUrl: avatarUrl || (await tangledAvatar(did)),
      };
    }

    const response = completeAuth(
      { provider: 'atproto', subject: did, displayName, avatarUrl },
      connection,
      { provider: 'atproto', mode: pending.mode, userId: pending.userId ?? null, payload: {} },
    );
    response.headers.append('Set-Cookie', clearCookie(pendingCookie, cookiePath(), isSecure()));
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = `atproto ${pending.mode === 'connect' ? 'connection' : 'sign-in'} failed: ${(error as Error).message}`;
    console.error(message, error);
    throw new HttpError(400, message);
  }
}
