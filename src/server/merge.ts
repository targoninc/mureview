import type { MergeResult } from '../shared/types';
import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { mapLimit } from './cache';
import { invalidateForgeCaches } from './forges';
import { HttpError, json } from './http';
import { buildMergePreview } from './mergePreview';
import { buildPrStatus, clientsFor } from './pr';
import { buildDetail, loadOwnedReviewSet, requireId } from './reviewSets';
import type { Ctx } from './router';
import { forgeErrorMessage } from './validate';

export async function getMergePreview(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  return json(await buildMergePreview(connectionsFor(user.id), reviewSet));
}

export async function mergeReviewSet(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const reviewSet = loadOwnedReviewSet(user, requireId(ctx));
  const connections = connectionsFor(user.id);
  const clients = clientsFor(connections);

  const current = await buildPrStatus(connections, reviewSet, true);
  const openRepos = current.repos.filter((repo) => repo.state === 'open' && repo.branch);
  if (!openRepos.length) {
    throw new HttpError(400, 'Nothing to merge: no matched branch has changes against the target branch.');
  }

  const target = reviewSet.targetBranch;
  const results = await mapLimit(openRepos, 3, async (repo): Promise<MergeResult> => {
    const label = `${repo.host}/${repo.repo}`;
    const client = clients.get(repo.connectionId);
    if (!client) return { connectionId: repo.connectionId, label, ok: false, message: 'the forge connection was removed' };
    try {
      if (repo.targetExists) {
        const message = await client.mergeBranch(repo.repo, target, repo.branch!, `mureview: merge ${repo.branch} into ${target}`);
        return { connectionId: repo.connectionId, label, ok: true, message };
      }
      const branchRef = await client.getBranch(repo.repo, repo.branch!, { fresh: true });
      if (!branchRef) throw new Error('the matched branch no longer exists');
      await client.createBranch(repo.repo, target, { sha: branchRef.sha, branch: repo.branch! });
      return { connectionId: repo.connectionId, label, ok: true, message: `created ${target} from ${repo.branch}` };
    } catch (error) {
      return { connectionId: repo.connectionId, label, ok: false, message: forgeErrorMessage(error) };
    }
  });

  invalidateForgeCaches();
  const detail = await buildDetail(user, reviewSet.id, true);
  return json({ results, detail });
}
