import { atprotoCallback, atprotoLoginStart } from './auth/atproto';
import {
  connectAdo,
  deleteConnection,
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
import { createCommentRoute, deleteCommentRoute, listCommentsRoute } from './comments';
import { config } from './config';
import { mergeReviewSet } from './merge';
import { listAvailableRepos } from './repoSearch';
import { setReviewedRoute } from './reviewed';
import { createReviewSet, deleteReviewSet, getReviewSet, listReviewSets, updateReviewSet } from './reviewSets';
import { Router } from './router';
import { requireUser } from './auth/session';
import type { Ctx } from './router';
import { json } from './http';

export const api = new Router();

api.get('/api/me', me, true);
api.post('/api/auth/register', register, true);
api.post('/api/auth/login', passwordLogin, true);
api.post('/api/auth/logout', logout, true);
api.get('/api/auth/login/github', githubLoginStart, true);
api.get('/api/auth/callback/github', githubCallback, true);
api.post('/api/auth/login/forgejo', forgejoLoginStart, true);
api.get('/api/auth/callback/forgejo', forgejoCallback, true);
api.get('/api/auth/login/atproto', atprotoLoginStart, true);
api.get('/api/auth/callback/atproto', atprotoCallback, true);

api.get('/api/connections', listConnections);
api.post('/api/connections/ado', connectAdo);
api.delete('/api/connections/:id', deleteConnection);
api.get('/api/repos', (ctx: Ctx) => listAvailableRepos(requireUser(ctx), ctx.url.searchParams.get('fresh') === '1').then((result) => json(result)));

api.get('/api/review-sets', listReviewSets);
api.post('/api/review-sets', createReviewSet);
api.get('/api/review-sets/:id', getReviewSet);
api.put('/api/review-sets/:id', updateReviewSet);
api.delete('/api/review-sets/:id', deleteReviewSet);
api.post('/api/review-sets/:id/merge', mergeReviewSet);

api.get('/api/prs/:id/comments', listCommentsRoute);
api.post('/api/prs/:id/comments', createCommentRoute);
api.delete('/api/comments/:id', deleteCommentRoute);
api.put('/api/prs/:id/reviewed', setReviewedRoute);

export function handleApi(req: Request, path: string, user: Parameters<typeof me>[0]['user']) {
  return api.handle(req, path, user, new URL(config.baseUrl).origin);
}
