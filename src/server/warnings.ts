import type { ForgeKind, TokenWarning } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { Cache, mapLimit } from './cache';
import { db } from './db';
import { clientFor } from './forges';
import { AdoClient } from './forges/ado';
import { json } from './http';
import type { Ctx } from './router';

const warnWithinDays = 7;
const expiryCache = new Cache<{ displayName: string; validTo: string } | null>(200, 60 * 60_000);
const forgeNames: Record<ForgeKind, string> = { github: 'GitHub', forgejo: 'Forgejo', ado: 'Azure DevOps', tangled: 'Tangled' };

function expiryText(daysLeft: number): string {
  if (daysLeft < 0) return 'has expired';
  if (daysLeft === 0) return 'expires today';
  if (daysLeft === 1) return 'expires tomorrow';
  return `expires in ${daysLeft} days`;
}

/**
 * Connections whose forge credentials expire soon. Forges that cannot report
 * an expiry (GitHub, Forgejo) skip the check; failures are cached for an hour
 * so a missing permission does not cause a request on every page load.
 */
export async function listWarnings(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const warnings: TokenWarning[] = [];

  await mapLimit(connectionsFor(user.id), 2, async (connection) => {
    const client = clientFor(connection);
    if (!client.tokenExpiry) return;

    // Azure DevOps avatars cannot be fetched by the browser; store the
    // account's avatar URL so the client can load it through the proxy.
    if (connection.kind === 'ado' && !connection.avatar_url && client instanceof AdoClient) {
      try {
        const account = await client.currentUser();
        if (account.avatarUrl) {
          db.run('UPDATE forge_connections SET avatar_url = ? WHERE id = ?', [account.avatarUrl, connection.id]);
        }
      } catch {
        // No avatar available; not worth a warning.
      }
    }

    const key = `${connection.id}#${Bun.hash(connection.access_token).toString(36)}`;
    let expiry = expiryCache.get(key);
    if (expiry === undefined) {
      try {
        expiry = await client.tokenExpiry();
      } catch {
        expiry = null;
      }
      expiryCache.set(key, expiry);
    }
    if (!expiry) return;

    const daysLeft = Math.ceil((new Date(expiry.validTo).getTime() - Date.now()) / 86_400_000);
    if (daysLeft > warnWithinDays) return;
    warnings.push({
      connectionId: connection.id,
      kind: connection.kind,
      message: `${forgeNames[connection.kind] ?? connection.kind} token ${expiryText(daysLeft)}`,
      displayName: expiry.displayName,
      validTo: expiry.validTo,
      daysLeft,
    });
  });

  warnings.sort((a, b) => a.daysLeft - b.daysLeft);
  return json({ warnings });
}
