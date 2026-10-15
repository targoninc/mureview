import { createHmac, createSign, timingSafeEqual } from 'node:crypto';

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  slug: string | null;
}

let cached: GithubAppConfig | null | undefined;

/** Re-reads the environment; used by tests after changing it. */
export function resetGithubApp(): void {
  cached = undefined;
}

/**
 * The optional GitHub App. When it is configured, mureview prefers
 * installation tokens for GitHub API calls and receives webhooks for every
 * installed repository through one endpoint. Without it, installations keep
 * using their OAuth tokens exactly as before.
 */
/** Accepts a PEM with real newlines, with \\n escapes, or base64-encoded. */
function readPrivateKey(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value.includes('BEGIN')) return value;
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (decoded.includes('BEGIN')) return decoded.trim();
  return value.replaceAll('\\n', '\n');
}

export function githubApp(): GithubAppConfig | null {
  if (cached !== undefined) return cached;
  const appId = (process.env.GITHUB_APP_ID ?? '').trim();
  const privateKey = readPrivateKey(process.env.GITHUB_APP_PRIVATE_KEY ?? '');
  if (!appId || !privateKey) {
    cached = null;
    return cached;
  }
  cached = {
    appId,
    privateKey,
    webhookSecret: (process.env.GITHUB_APP_WEBHOOK_SECRET ?? '').trim(),
    slug: (process.env.GITHUB_APP_SLUG ?? '').trim() || null,
  };
  return cached;
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

let jwtCache: { token: string; expires: number } | null = null;

/** A short-lived app JWT, as GitHub requires for app-level requests. */
export function appJwt(): string {
  const app = githubApp();
  if (!app) throw new Error('the GitHub App is not configured');
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache && jwtCache.expires > now + 60) return jwtCache.token;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 30, exp: now + 540, iss: app.appId }));
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  sign.end();
  const signature = sign.sign(app.privateKey).toString('base64url');
  jwtCache = { token: `${header}.${payload}.${signature}`, expires: now + 540 };
  return jwtCache.token;
}

const installationTokens = new Map<string, { token: string; expires: number }>();

/** A token for one installation; GitHub issues them for an hour. */
export async function installationToken(installationId: string): Promise<string> {
  const cachedToken = installationTokens.get(installationId);
  if (cachedToken && cachedToken.expires - Date.now() > 5 * 60_000) return cachedToken.token;
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mureview' },
  });
  if (!response.ok) throw new Error(`GitHub refused an installation token (${response.status})`);
  const data = (await response.json()) as { token: string; expires_at: string };
  installationTokens.set(installationId, { token: data.token, expires: new Date(data.expires_at).getTime() });
  return data.token;
}

export function cachedInstallationToken(installationId: string): string | null {
  const cachedToken = installationTokens.get(installationId);
  return cachedToken && cachedToken.expires - Date.now() > 60_000 ? cachedToken.token : null;
}

/**
 * Attaches the account's installation to a connection, so a connection made
 * after the app was installed still uses installation tokens.
 */
export async function attachGithubInstallation(connectionId: number, login: string): Promise<void> {
  if (!githubApp() || !login) return;
  try {
    const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}/installation`, {
      headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mureview' },
    });
    if (!response.ok) return;
    const data = (await response.json()) as { id?: number };
    if (!data.id) return;
    const { db } = await import('./db');
    const { invalidateForgeCaches } = await import('./forges');
    db.run('UPDATE forge_connections SET installation_id = ? WHERE id = ?', [String(data.id), connectionId]);
    invalidateForgeCaches();
  } catch (error) {
    console.error('Could not look up the GitHub App installation:', error);
  }
}

const repoInstallations = new Map<string, string | null>();

/**
 * The installation covering a repository, looked up with the app JWT. This is
 * how organization installations reach connections whose account is not the
 * organization itself.
 */
export async function installationForRepo(repo: string): Promise<string | null> {
  if (!githubApp()) return null;
  if (repoInstallations.has(repo)) return repoInstallations.get(repo) ?? null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/installation`, {
      headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mureview' },
    });
    const id = response.ok ? String(((await response.json()) as { id?: number }).id ?? '') || null : null;
    repoInstallations.set(repo, id);
    return id;
  } catch (error) {
    console.error(`Could not look up the installation for ${repo}:`, error);
    return null;
  }
}

export function forgetRepoInstallation(repo: string): void {
  repoInstallations.delete(repo);
}

export interface GithubInstallation {
  id: number;
  account: string;
  selection: string;
  /** Organizations manage installations under their own settings path. */
  organization: boolean;
}

let installations: GithubInstallation[] = [];
let installationsAt = 0;

/** The app's installations, cached and refreshed in the background. */
export function githubInstallations(): GithubInstallation[] {
  if (githubApp() && Date.now() - installationsAt > 60_000) void refreshGithubInstallations();
  return installations;
}

/** The app's installations, refreshed when the cache is older than a minute. */
export async function freshGithubInstallations(): Promise<GithubInstallation[]> {
  if (!githubApp()) return [];
  if (Date.now() - installationsAt > 60_000) await refreshGithubInstallations();
  return installations;
}

export async function refreshGithubInstallations(): Promise<GithubInstallation[]> {
  const app = githubApp();
  if (!app) return [];
  try {
    const response = await fetch('https://api.github.com/app/installations?per_page=100', {
      headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mureview' },
    });
    if (!response.ok) return installations;
    const data = (await response.json()) as Array<{
      id?: number;
      account?: { login?: string; type?: string };
      repository_selection?: string;
    }>;
    installations = data
      .filter((entry) => entry.id && entry.account?.login)
      .map((entry) => ({
        id: entry.id!,
        account: entry.account!.login!,
        selection: entry.repository_selection === 'all' ? 'all repositories' : 'selected repositories',
        organization: entry.account!.type === 'Organization',
      }));
    installationsAt = Date.now();
    return installations;
  } catch (error) {
    console.error('Could not list the GitHub App installations:', error);
    return installations;
  }
}

let resolvedSlug: string | null = null;

/**
 * Reads the app's slug from GitHub so GITHUB_APP_SLUG is optional; the
 * environment value wins when set.
 */
export async function resolveGithubAppSlug(): Promise<string | null> {
  const app = githubApp();
  if (!app) return null;
  if (app.slug) return app.slug;
  if (resolvedSlug) return resolvedSlug;
  try {
    const response = await fetch('https://api.github.com/app', {
      headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'mureview' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { slug?: string };
    resolvedSlug = data.slug ?? null;
    return resolvedSlug;
  } catch (error) {
    console.error('Could not read the GitHub App slug:', error);
    return null;
  }
}

export function githubAppSlug(): string | null {
  return githubApp()?.slug ?? resolvedSlug;
}

export function forgetInstallation(installationId: string): void {
  installationTokens.delete(installationId);
}

export function verifyAppSignature(body: string, signature: string): boolean {
  const app = githubApp();
  if (!app?.webhookSecret || !signature) return false;
  const expected = `sha256=${createHmac('sha256', app.webhookSecret).update(body).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
