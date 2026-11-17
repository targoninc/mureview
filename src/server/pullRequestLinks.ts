import type { ForgeConnectionRow } from './db';
import { hostOf, organizationOf } from './forges';

export interface PullRequestLink {
  connection: ForgeConnectionRow;
  repo: string;
  ref: string;
}

interface ParsedPath {
  repo: string;
  ref: string;
}

function stripBasePath(path: string, baseUrl: string): string {
  const basePath = organizationOf(baseUrl);
  if (!basePath) return path;
  const prefix = `/${basePath}`;
  return path === prefix || path.startsWith(`${prefix}/`) ? path.slice(prefix.length) || '/' : path;
}

function parseGithub(path: string): ParsedPath | null {
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/.exec(path);
  return match ? { repo: `${match[1]}/${match[2]}`, ref: match[3] } : null;
}

function parseForgejo(path: string): ParsedPath | null {
  const match = /^\/([^/]+)\/([^/]+)\/pulls?\/([^/]+)(?:\/.*)?$/.exec(path);
  return match ? { repo: `${match[1]}/${match[2]}`, ref: match[3] } : null;
}

function parseAdo(path: string): ParsedPath | null {
  const match = /^\/(?:.*?\/)?([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)(?:\/.*)?$/.exec(path);
  return match ? { repo: `${match[1]}/${match[2]}`, ref: match[3] } : null;
}

function parsePath(kind: ForgeConnectionRow['kind'], path: string): ParsedPath | null {
  if (kind === 'github') return parseGithub(path);
  if (kind === 'forgejo') return parseForgejo(path);
  if (kind === 'ado') return parseAdo(path);
  return null;
}

export function parsePullRequestLink(raw: string, connections: ForgeConnectionRow[]): PullRequestLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`"${raw}" is not an HTTP URL.`);
  }
  const host = url.host.toLowerCase();
  const candidates = connections.filter((connection) => hostOf(connection.base_url).toLowerCase() === host);
  if (candidates.length === 0) {
    throw new Error(`No forge connection matches ${url.host}. Connect that forge under Settings first.`);
  }
  for (const connection of candidates) {
    const path = stripBasePath(url.pathname.replace(/\/+$/, ''), connection.base_url);
    const parsed = parsePath(connection.kind, path);
    if (parsed) return { connection, ...parsed };
  }
  throw new Error(`Could not read a pull request from "${raw}". Paste a {forge} pull request URL.`.replace('{forge}', candidates[0].kind));
}

export function parsePullRequestLinks(input: unknown, connections: ForgeConnectionRow[]): PullRequestLink[] {
  const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,]+/) : [];
  const urls = values.map((value) => String(value).trim()).filter(Boolean);
  const links: PullRequestLink[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const link = parsePullRequestLink(raw, connections);
    const key = `${link.connection.id}:${link.repo}:${link.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  return links;
}
