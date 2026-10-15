import type { ForgeConnectionRow } from '../db';
import { mintAtprotoServiceAuth } from '../atproto/client';
import { decrypt } from '../crypto';
import { AdoClient, invalidateAdoBranchCaches } from './ado';
import { ForgejoClient, invalidateForgejoBranchCaches, refreshForgejoToken } from './forgejo';
import { cachedInstallationToken, githubApp, installationToken } from '../githubApp';
import { GithubClient, invalidateGithubBranchCaches, refreshGithubToken } from './github';
import { TangledClient, invalidateTangledBranchCaches } from './tangled';
import type { ForgeClient } from './types';

export function clientFor(connection: ForgeConnectionRow): ForgeClient {
  const token = decrypt(connection.access_token);
  const baseUrl = connection.base_url;
  if (connection.kind === 'forgejo') {
    return new ForgejoClient(baseUrl, token, { refresh: () => refreshForgejoToken(connection.id) });
  }
  if (connection.kind === 'ado') return new AdoClient(baseUrl, token, connection.login);
  if (connection.kind === 'tangled') {
    const did = token || connection.login;
    return new TangledClient(baseUrl, connection.login || did, {
      did,
      serviceAuth: (options) => mintAtprotoServiceAuth(did, options),
    });
  }
  const app = githubApp();
  if (app && connection.installation_id) {
    // Prefer the app installation; fall back to the account's OAuth token if
    // the installation is gone or refuses a token.
    const installation = connection.installation_id;
    return new GithubClient(cachedInstallationToken(installation) ?? '', {
      refresh: async () => {
        try {
          return await installationToken(installation);
        } catch (error) {
          console.error(`Could not mint a GitHub App token for ${connection.login}:`, error);
          return refreshGithubToken(connection.id);
        }
      },
      fallback: () => token,
    });
  }
  return new GithubClient(token, { refresh: () => refreshGithubToken(connection.id) });
}

export function connectionSecret(connection: ForgeConnectionRow): string {
  return connection.client_secret ? decrypt(connection.client_secret) : '';
}

export function invalidateForgeCaches(): void {
  invalidateGithubBranchCaches();
  invalidateForgejoBranchCaches();
  invalidateAdoBranchCaches();
  invalidateTangledBranchCaches();
}

export * from './types';
