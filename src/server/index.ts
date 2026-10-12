import { config } from './config';
import { getSessionUser } from './auth';
import './db';
import { json } from './http';
import { handleApi } from './routes';
import { serveStatic } from './static';

const server = Bun.serve({
  port: config.port,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    if (config.basePath) {
      if (path === config.basePath || path === `${config.basePath}/`) path = '/';
      else if (path.startsWith(`${config.basePath}/`)) path = path.slice(config.basePath.length);
    }

    if (path.startsWith('/api/')) {
      const response = await handleApi(req, path, getSessionUser(req));
      return response ?? json({ error: 'Not found' }, 404);
    }
    return serveStatic(path);
  },
});

console.log(`mureview listening on ${config.baseUrl} (port ${server.port})`);
