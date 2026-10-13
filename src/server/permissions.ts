import { connectionOrMatching } from './auth/identities';
import { Cache, cached, mapLimit } from './cache';
import type { ForgeConnectionRow } from './db';
import { clientFor } from './forges';

const permissionCache = new Cache<'write' | 'read' | 'unknown'>(2000, 60_000);

export interface ManageableRepo {
  connectionId: number;
  repo: string;
}

/**
 * Whether the actor may merge every listed repository with their own
 * credentials: they need write access to each one. A forge that cannot report
 * permissions counts as allowed, like the merge preview does.
 */
export async function canManageRepoList(
  actorId: number,
  repos: ManageableRepo[],
  connections: ForgeConnectionRow[],
): Promise<boolean> {
  if (!repos.length) return false;
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const allowed = await mapLimit(repos, 4, async (repo) => {
    const owner = byId.get(repo.connectionId);
    if (!owner) return false;
    const actor = connectionOrMatching(actorId, owner.id);
    if (!actor) return false;
    const client = clientFor(actor);
    if (client.readOnly) return false;
    if (!client.pullRequestPermission) return true;
    const permission = await cached(permissionCache, `${actor.id}#${repo.repo}`, () => client.pullRequestPermission!(repo.repo));
    return permission !== 'read';
  });
  return allowed.every(Boolean);
}

/** Whether the actor may merge every branch of a review set. */
export function canManageReviewSet(
  actorId: number,
  reviewSet: { repos: ManageableRepo[] },
  connections: ForgeConnectionRow[],
): Promise<boolean> {
  return canManageRepoList(actorId, reviewSet.repos, connections);
}
