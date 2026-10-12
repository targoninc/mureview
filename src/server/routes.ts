import { handleCallback, handleLogin, handleLogout, handleMe, type UserRow } from './auth';
import { createCommentRoute, deleteCommentRoute, listCommentsRoute } from './comments';
import { config } from './config';
import { createReviewSet, deleteReviewSet, getReviewSet, listReviewSets, updateReviewSet } from './reviewSets';
import { Router } from './router';

export const api = new Router();

api.get('/api/me', handleMe, true);
api.get('/api/auth/login', handleLogin, true);
api.get('/api/auth/callback', handleCallback, true);
api.post('/api/auth/logout', handleLogout, true);

api.get('/api/review-sets', listReviewSets);
api.post('/api/review-sets', createReviewSet);
api.get('/api/review-sets/:id', getReviewSet);
api.put('/api/review-sets/:id', updateReviewSet);
api.delete('/api/review-sets/:id', deleteReviewSet);

api.get('/api/prs/:id/comments', listCommentsRoute);
api.post('/api/prs/:id/comments', createCommentRoute);
api.delete('/api/comments/:id', deleteCommentRoute);

export function handleApi(req: Request, path: string, user: UserRow | null) {
  return api.handle(req, path, user, new URL(config.baseUrl).origin);
}
