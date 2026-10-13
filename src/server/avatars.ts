import { connectionOrMatching } from './auth/identities';
import { requireUser } from './auth/session';
import { clientFor } from './forges';
import { HttpError } from './http';
import type { Ctx } from './router';

const cacheMax = 200;
const cacheTtl = 60 * 60 * 1000;
const cache = new Map<string, { contentType: string; body: Buffer; at: number }>();

function imageResponse(contentType: string, body: Buffer): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, max-age=600',
      'Content-Length': String(body.length),
    },
  });
}

/**
 * Serves avatars that live behind forge authentication. Only URLs on the
 * connection's own host are fetched, so this cannot be used as an open proxy.
 */
export async function forgeAvatarRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const connectionId = Number(ctx.url.searchParams.get('connectionId'));
  const raw = ctx.url.searchParams.get('url') ?? '';
  // On shared review sets the comment's avatar belongs to the owner's
  // connection; fall back to the viewer's matching connection, which is what
  // they also need to post comments with.
  const connection = Number.isInteger(connectionId) ? connectionOrMatching(user.id, connectionId) : null;
  if (!connection) throw new HttpError(404, 'Connection not found');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid avatar URL');
  }
  const base = new URL(connection.base_url);
  if (url.host !== base.host || url.protocol !== base.protocol) {
    throw new HttpError(400, 'Avatar URL is not hosted on the connection host');
  }

  const key = `${connection.id}:${url.toString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheTtl) return imageResponse(hit.contentType, hit.body);

  const image = await clientFor(connection).fetchAvatar(url.toString());
  if (!image) throw new HttpError(404, 'Avatar not available');

  cache.set(key, { ...image, at: Date.now() });
  while (cache.size > cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return imageResponse(image.contentType, image.body);
}
