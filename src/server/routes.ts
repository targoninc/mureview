import { atprotoCallback, atprotoLoginStart } from './auth/atproto';
import {
  connectAdo,
  deleteAccountData,
  deleteConnection,
  entraCallback,
  entraLoginStart,
  forgejoCallback,
  forgejoLoginStart,
  githubCallback,
  githubLoginStart,
  listConnections,
  logout,
  me,
  passwordLogin,
  register,
} from './auth/providers';
import { createCommentRoute, deleteCommentRoute, listCommentsRoute, resolveCommentRoute } from './comments';
import { forgeAvatarRoute } from './avatars';
import { resolveMentionRoute, resolveReferenceRoute } from './refs';
import { config } from './config';
import { reviewPullRequestRoute } from './reviews';
import { updatePreferences } from './preferences';
import { mergeReviewSet, streamMergePreview } from './merge';
import { listAvailableRepos, listRepoBranches } from './repoSearch';
import { setReviewedRoute } from './reviewed';
import {
  createReviewSet,
  deleteReviewSet,
  getReviewSetCommits,
  getReviewSetChecks,
  getReviewSetDiscussion,
  getReviewSetProgress,
  listReviewSets,
  streamReviewSetDetail,
  updateReviewSet,
} from './reviewSets';
import { Router } from './router';
import { requireUser } from './auth/session';
import type { Ctx } from './router';
import { HttpError, json } from './http';
import { listWarnings } from './warnings';

export const api = new Router();

api.get('/api/me', me, true);
api.put('/api/me/preferences', updatePreferences);
api.get('/api/warnings', listWarnings);
api.post('/api/auth/register', register, true);
api.post('/api/auth/login', passwordLogin, true);
api.post('/api/auth/logout', logout, true);
api.get('/api/auth/login/github', githubLoginStart, true);
api.get('/api/auth/callback/github', githubCallback, true);
// Legacy callback path, kept so OAuth apps registered before the provider
// split keep working.
api.get('/api/auth/callback', githubCallback, true);
api.post('/api/auth/login/forgejo', forgejoLoginStart, true);
api.get('/api/auth/callback/forgejo', forgejoCallback, true);
api.get('/api/auth/login/atproto', atprotoLoginStart, true);
api.get('/api/auth/callback/atproto', atprotoCallback, true);
api.get('/api/auth/login/entra', entraLoginStart, true);
api.get('/api/auth/callback/entra', entraCallback, true);

api.get('/api/connections', listConnections);
api.post('/api/connections/ado', connectAdo);
api.delete('/api/account/data', deleteAccountData);
api.delete('/api/connections/:id', deleteConnection);
api.get('/api/repos', (ctx: Ctx) => listAvailableRepos(requireUser(ctx), ctx.url.searchParams.get('fresh') === '1').then((result) => json(result)));
api.get('/api/repos/branches', (ctx: Ctx) => {
  const user = requireUser(ctx);
  const connectionId = Number(ctx.url.searchParams.get('connectionId'));
  const repo = ctx.url.searchParams.get('repo') ?? '';
  if (!Number.isInteger(connectionId) || !repo) throw new HttpError(400, 'A connection and repository are required.');
  return listRepoBranches(user, connectionId, repo).then((branches) => json({ branches }));
});

api.get('/api/review-sets', listReviewSets);
api.post('/api/review-sets', createReviewSet);
api.get('/api/review-sets/:id/detail', streamReviewSetDetail);
api.get('/api/review-sets/:id/progress', getReviewSetProgress);
api.get('/api/review-sets/:id/commits', getReviewSetCommits);
api.get('/api/review-sets/:id/checks', getReviewSetChecks);
api.get('/api/review-sets/:id/discussion', getReviewSetDiscussion);
api.put('/api/review-sets/:id', updateReviewSet);
api.delete('/api/review-sets/:id', deleteReviewSet);
api.get('/api/review-sets/:id/merge', streamMergePreview);
api.post('/api/review-sets/:id/merge', mergeReviewSet);
api.post('/api/review-sets/:id/review', reviewPullRequestRoute);

api.get('/api/prs/:id/comments', listCommentsRoute);
api.post('/api/prs/:id/comments', createCommentRoute);
api.delete('/api/comments/:id', deleteCommentRoute);
api.post('/api/comments/:id/resolve', resolveCommentRoute);
api.get('/api/forge-avatar', forgeAvatarRoute);
api.get('/api/refs', resolveReferenceRoute);
api.get('/api/mentions', resolveMentionRoute);
api.put('/api/prs/:id/reviewed', setReviewedRoute);

export function handleApi(req: Request, path: string, user: Parameters<typeof me>[0]['user']) {
  return api.handle(req, path, user, new URL(config.baseUrl).origin);
}
