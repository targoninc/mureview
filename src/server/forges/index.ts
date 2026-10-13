import type { ForgeConnectionRow } from '../db';
import { mintAtprotoServiceAuth } from '../atproto/client';
import { decrypt } from '../crypto';
import { AdoClient, invalidateAdoBranchCaches } from './ado';
import { ForgejoClient, invalidateForgejoBranchCaches, refreshForgejoToken } from './forgejo';
import { GithubClient, invalidateGithubBranchCaches, refreshGithubToken } from './github';
import { TangledClient, invalidateTangledBranchCaches } from './tangled';
import type { ForgeClient } from './types';

export function clientFor(connection: ForgeConnectionRow): ForgeClient {
  const token = decrypt(connection.access_token);
  const baseUrl = connection.base_url;
  if (connection.kind === 'forgejo') {
    return new ForgejoClient(baseUrl, token, { refresh: () => refreshForgejoToken(connection.id) });
  }
  if (connection.kind === 'ado') return new AdoClient(baseUrl, token);
  if (connection.kind === 'tangled') {
    const did = token || connection.login;
    return new TangledClient(baseUrl, connection.login || did, {
      did,
      serviceAuth: (options) => mintAtprotoServiceAuth(did, options),
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
