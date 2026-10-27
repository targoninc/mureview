import { atprotoMetadata } from './auth/atproto';
import { getSessionUser } from './auth/session';
import { refreshGithubInstallations, resolveGithubAppSlug } from './githubApp';
import { config } from './config';
import './db';
import { json } from './http';
import { handleApi } from './routes';
import { liveClose, liveMessage, liveOpen, type LiveData } from './live';
import { serveStatic } from './static';

/** Headers every response carries, whatever the route. */
function secure(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (config.baseUrl.startsWith('https://') && !headers.has('Strict-Transport-Security')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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
      // WebSocket handshakes carry cookies; reject cross-origin pages so a
      // foreign site cannot subscribe with a signed-in reader's session.
      const origin = req.headers.get('origin');
      if (origin && origin !== new URL(config.baseUrl).origin) {
        return secure(json({ error: 'Cross-origin request rejected' }, 403));
      }
      const user = getSessionUser(req);
      if (!user) return secure(json({ error: 'Unauthorized' }, 401));
      if (server.upgrade(req, { data: { user, reviewSets: new Map<number, number>() } })) return undefined;
      return secure(json({ error: 'Expected a websocket upgrade' }, 400));
    }
    if (path === '/healthz') return secure(json({ ok: true }));
    if (path === '/oauth-client-metadata.json') return secure(json(atprotoMetadata));

    if (path.startsWith('/api/')) {
      const response = await handleApi(req, path, getSessionUser(req));
      return secure(response ?? json({ error: 'Not found' }, 404));
    }
    return secure(await serveStatic(path));
  },
});

console.log(`mureview listening on ${config.baseUrl} (port ${server.port})`);

// Fill in the GitHub App slug for the settings link without requiring the env.
void resolveGithubAppSlug();
void refreshGithubInstallations();
