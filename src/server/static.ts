import { join, normalize, sep } from 'node:path';
import { config } from './config';

let indexCache: string | null = null;

async function serveIndex(): Promise<Response> {
  if (indexCache === null) {
    const indexFile = Bun.file(join(config.distDir, 'index.html'));
    if (!(await indexFile.exists())) {
      return new Response('Client build not found. Run "bun run build" first.', { status: 503 });
    }
    indexCache = (await indexFile.text()).replace('<head>', `<head><base href="${config.basePath}/">`);
  }
  return new Response(indexCache, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
}

function cacheControl(pathname: string): string {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
}

export async function serveStatic(pathname: string): Promise<Response> {
  if (pathname === '/' || pathname.endsWith('/') || !pathname.includes('.')) return serveIndex();

  const resolved = normalize(join(config.distDir, pathname));
  if (!resolved.startsWith(config.distDir + sep)) return serveIndex();

  const file = Bun.file(resolved);
  if (await file.exists()) {
    return new Response(file, { headers: { 'Cache-Control': cacheControl(pathname) } });
  }
  return serveIndex();
}
