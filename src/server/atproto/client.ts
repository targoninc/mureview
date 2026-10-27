import { AtprotoHandleResolver } from '@atproto-labs/handle-resolver';
import { NodeOAuthClient, type NodeSavedSession, type NodeSavedSessionStore } from '@atproto/oauth-client-node';
import { Agent } from '@atproto/api';
import { config } from '../config';
import { resolveHandleTxt } from './handle';

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

/**
 * Atproto OAuth sessions, encrypted at rest. Tangled writes mint service-auth
 * tokens through them, so they must outlive a restart — the in-memory store
 * the sign-in flow used to keep would have lost them.
 */
class AtprotoSessionStore implements NodeSavedSessionStore {
  async get(key: string): Promise<NodeSavedSession | undefined> {
    const [{ db }, { decrypt }] = await Promise.all([import('../db'), import('../crypto')]);
    const row = db.query<{ session: string }, [string]>('SELECT session FROM atproto_sessions WHERE did = ?').get(key);
    if (!row) return undefined;
    try {
      return JSON.parse(decrypt(row.session)) as NodeSavedSession;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: NodeSavedSession): Promise<void> {
    const [{ db }, { encrypt }] = await Promise.all([import('../db'), import('../crypto')]);
    db.run(
      `INSERT INTO atproto_sessions (did, session, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(did) DO UPDATE SET session = excluded.session, updated_at = excluded.updated_at`,
      [key, encrypt(JSON.stringify(value))],
    );
  }

  async del(key: string): Promise<void> {
    const { db } = await import('../db');
    db.run('DELETE FROM atproto_sessions WHERE did = ?', [key]);
  }
}

export const atprotoMetadata = {
  client_id: `${config.baseUrl}/oauth-client-metadata.json`,
  client_name: 'mureview',
  client_uri: config.baseUrl,
  redirect_uris: [`${config.baseUrl}/api/auth/callback/atproto`],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  // The transitional "atproto" scope covers everything on PDSes that grant it;
  // the granular rpc permissions are what newer PDSes actually hand out, and
  // they are what Tangled writes need when a token is minted for a knot.
  scope: [
    'atproto',
    'rpc:com.atproto.repo.createRecord?aud=*',
    'rpc:com.atproto.repo.putRecord?aud=*',
    'rpc:com.atproto.repo.deleteRecord?aud=*',
    'rpc:sh.tangled.repo.pull.merge?aud=*',
  ].join(' '),
  dpop_bound_access_tokens: true,
  token_endpoint_auth_method: 'none',
  application_type: 'web',
};

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

export function atprotoClient(): NodeOAuthClient {
  if (!client) {
    client = new NodeOAuthClient({
      clientMetadata: atprotoMetadata as ConstructorParameters<typeof NodeOAuthClient>[0]['clientMetadata'],
      stateStore: new MemoryStore(),
      sessionStore: new AtprotoSessionStore(),
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

/** Whether a stored atproto session exists for a DID. */
export async function hasAtprotoSession(did: string): Promise<boolean> {
  const { db } = await import('../db');
  return Boolean(db.query<{ did: string }, [string]>('SELECT did FROM atproto_sessions WHERE did = ?').get(did));
}

/**
 * Mints a service-auth JWT for another service through the user's PDS: the
 * PDS signs {iss, aud, lxm, exp} with the account's signing key, and the
 * target verifies it against the account's DID document.
 */
export async function mintAtprotoServiceAuth(did: string, options: { aud: string; lxm: string; expiresInSeconds?: number }): Promise<string> {
  let oauth: NodeOAuthClient;
  try {
    oauth = atprotoClient();
  } catch (error) {
    throw new Error(`no atproto session for this account — sign in with atproto first (${(error as Error).message})`);
  }
  const session = await oauth.restore(did).catch(() => {
    throw new Error('no atproto session for this account — sign in with atproto first');
  });
  const agent = new Agent(session);
  const exp = Math.floor(Date.now() / 1000) + Math.max(options.expiresInSeconds ?? 60, 60);
  const { data } = await agent.com.atproto.server.getServiceAuth({ aud: options.aud, lxm: options.lxm, exp });
  return data.token;
}
