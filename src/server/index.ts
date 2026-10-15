import { atprotoMetadata } from './auth/atproto';
import { getSessionUser } from './auth/session';
import { config } from './config';
import './db';
import { json } from './http';
import { handleApi } from './routes';
import { liveClose, liveMessage, liveOpen, type LiveData } from './live';
import { serveStatic } from './static';

const server = Bun.serve<LiveData>({
  port: config.port,
  idleTimeout: 60,
  websocket: {
    open: liveOpen,
    close: liveClose,
    message: liveMessage,
    idleTimeout: 120,
  },
  async fetch(req, server) {
    const url = new URL(req.url);
    let path = url.pathname;

    if (config.basePath) {
      if (path === config.basePath || path === `${config.basePath}/`) path = '/';
      else if (path.startsWith(`${config.basePath}/`)) path = path.slice(config.basePath.length);
    }

    if (path === '/api/live') {
      const user = getSessionUser(req);
      if (!user) return json({ error: 'Unauthorized' }, 401);
      if (server.upgrade(req, { data: { user, reviewSets: new Map<number, number>() } })) return undefined;
      return json({ error: 'Expected a websocket upgrade' }, 400);
    }
    if (path === '/healthz') return json({ ok: true });
    if (path === '/oauth-client-metadata.json') return json(atprotoMetadata);

    if (path.startsWith('/api/')) {
      const response = await handleApi(req, path, getSessionUser(req));
      return response ?? json({ error: 'Not found' }, 404);
    }
    return serveStatic(path);
  },
});

console.log(`mureview listening on ${config.baseUrl} (port ${server.port})`);
