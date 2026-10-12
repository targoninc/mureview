import { join } from 'node:path';

const port = Number(process.env.PORT ?? 8081);
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  baseUrl,
  basePath: new URL(baseUrl).pathname.replace(/\/+$/, ''),
  dbPath: process.env.DATABASE_PATH ?? 'data/mureview.db',
  githubClientId: process.env.GITHUB_CLIENT_ID ?? '',
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  distDir: join(import.meta.dir, '..', '..', 'dist'),
};

export const constants = {
  sessionCookie: 'mureview_sid',
  stateCookie: 'mureview_oauth_state',
  sessionDays: 30,
  maxBranchesPerRepo: 1,
  maxRepoFiles: 300,
  maxFileBytes: 200_000,
};
