import { connectionsFor } from './auth/identities';
import { requireUser } from './auth/session';
import { HttpError, json, readJson } from './http';
import { clientsForActor } from './pr';
import { reviewSetPullRequest } from './pullRequests';
import { loadReadableReviewSet, requireId } from './reviewSets';

import type { Ctx } from './router';
import type { ReviewVote } from '../shared/types';

/**
 * Records the acting user's review decision on a layer's pull request with
 * their own forge credentials.
 */
export async function reviewPullRequestRoute(ctx: Ctx): Promise<Response> {
  const user = requireUser(ctx);
  const access = await loadReadableReviewSet(user, requireId(ctx));
  const body = await readJson<{ connectionId?: unknown; repo?: unknown; position?: unknown; vote?: unknown }>(ctx.req);
  const vote = body.vote;
  if (vote !== 'approve' && vote !== 'waiting' && vote !== 'reject') throw new HttpError(400, 'Unknown review decision.');
  const connectionId = Number(body.connectionId);
  const repo = typeof body.repo === 'string' ? body.repo : '';
  const position = Number.isInteger(body.position) && (body.position as number) >= 0 ? (body.position as number) : 0;
  if (!Number.isInteger(connectionId) || !repo) throw new HttpError(400, 'A connection and repository are required.');

  const client = clientsForActor(user.id, connectionsFor(access.ownerId)).get(connectionId);
  if (!client?.reviewPullRequest) throw new HttpError(400, 'This forge has no review decisions.');

  const ref = reviewSetPullRequest(access.reviewSet.id, connectionId, repo, position);
  if (!ref) throw new HttpError(400, 'There is no pull request for this layer yet.');

  await client.reviewPullRequest(repo, ref, vote as ReviewVote);
  return json({ ok: true, vote });
}
