import type { UserRow } from './auth';
import { HttpError, json } from './http';

export interface Ctx {
  req: Request;
  url: URL;
  path: string;
  params: Record<string, string>;
  user: UserRow | null;
}

export type Handler = (ctx: Ctx) => Response | Promise<Response>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  isPublic: boolean;
}

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, isPublic = false): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, isPublic });
    return this;
  }

  get(pattern: string, handler: Handler, isPublic = false) {
    return this.add('GET', pattern, handler, isPublic);
  }

  post(pattern: string, handler: Handler, isPublic = false) {
    return this.add('POST', pattern, handler, isPublic);
  }

  put(pattern: string, handler: Handler, isPublic = false) {
    return this.add('PUT', pattern, handler, isPublic);
  }

  delete(pattern: string, handler: Handler, isPublic = false) {
    return this.add('DELETE', pattern, handler, isPublic);
  }

  async handle(req: Request, path: string, user: UserRow | null, trustedOrigin: string): Promise<Response | null> {
    const segments = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== req.method || route.parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < segments.length; i++) {
        const part = route.parts[i];
        if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(segments[i]);
        else if (part !== segments[i]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      if (!route.isPublic && !user) return json({ error: 'Authentication required' }, 401);
      const origin = req.headers.get('origin');
      if (mutating.has(req.method) && origin && origin !== trustedOrigin) {
        return json({ error: 'Cross-origin request rejected' }, 403);
      }
      try {
        return await route.handler({ req, url: new URL(req.url), path, params, user });
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status);
        console.error(`${req.method} ${path} failed:`, error);
        return json({ error: 'Internal server error' }, 500);
      }
    }
    return null;
  }
}
