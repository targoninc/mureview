import type { RefInfo } from '../shared/types';
import { connectionOrMatching } from './auth/identities';
import { requireUser } from './auth/session';
import { Cache } from './cache';
import { clientFor } from './forges';
import { HttpError, json } from './http';
import type { Ctx } from './router';

const refCache = new Cache<RefInfo | null>(500, 60 * 60_000);
const mentionCache = new Cache<{ name: string; url?: string } | null>(500, 60 * 60_000);

/**
 * Resolves what a "#123" (or Azure DevOps "!123") reference in a comment
 * points at, so the client can render a labelled link with the right target
 * and title — Azure DevOps pull request ids can point at any repository.
 */
export async function resolveReferenceRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const connectionId = Number(ctx.url.searchParams.get('connectionId'));
  const repo = ctx.url.searchParams.get('repo') ?? '';
  const type = ctx.url.searchParams.get('type');
  const id = ctx.url.searchParams.get('id') ?? '';
  if (!Number.isInteger(connectionId) || !repo || (type !== 'pr' && type !== 'issue' && type !== 'work') || !/^\d+$/.test(id)) {
    throw new HttpError(400, 'Invalid reference');
  }

  const connection = connectionOrMatching(user.id, connectionId);
  if (!connection) throw new HttpError(404, 'Connection not found');

  const key = `${connection.id}#${type}#${repo}#${id}`;
  const cached = refCache.get(key);
  if (cached !== undefined) return json({ ref: cached });

  const client = clientFor(connection);
  let ref: RefInfo | null = null;
  if (client.resolveReference) {
    try {
      ref = await client.resolveReference(repo, type, id);
    } catch {
      ref = null;
    }
  }
  refCache.set(key, ref, ref ? 60 * 60_000 : 5 * 60_000);
  return json({ ref });
}

/**
 * Names the account a forge-specific mention points at, like Azure DevOps's
 * `@<identity-id>`; forges without such syntax answer null and the client
 * leaves the text as written.
 */
export async function resolveMentionRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const connectionId = Number(ctx.url.searchParams.get('connectionId'));
  const id = ctx.url.searchParams.get('id') ?? '';
  if (!Number.isInteger(connectionId) || !id || id.length > 100) throw new HttpError(400, 'Invalid mention');

  const connection = connectionOrMatching(user.id, connectionId);
  if (!connection) throw new HttpError(404, 'Connection not found');

  const key = `${connection.id}#${id}`;
  const cached = mentionCache.get(key);
  if (cached !== undefined) return json({ mention: cached });

  const client = clientFor(connection);
  let mention: { name: string; url?: string } | null = null;
  if (client.resolveMention) {
    try {
      mention = await client.resolveMention(id);
    } catch {
      mention = null;
    }
  }
  mentionCache.set(key, mention, mention ? 60 * 60_000 : 5 * 60_000);
  return json({ mention });
}
