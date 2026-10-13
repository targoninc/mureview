import type { ForgeConnectionRow } from '../db';
import { decrypt } from '../crypto';
import { AdoClient, invalidateAdoBranchCaches } from './ado';
import { ForgejoClient, invalidateForgejoBranchCaches } from './forgejo';
import { GithubClient, invalidateGithubBranchCaches } from './github';
import { TangledClient, invalidateTangledBranchCaches } from './tangled';
import type { ForgeClient } from './types';

export function clientFor(connection: ForgeConnectionRow): ForgeClient {
  const token = decrypt(connection.access_token);
  const baseUrl = connection.base_url;
  if (connection.kind === 'forgejo') return new ForgejoClient(baseUrl, token);
  if (connection.kind === 'ado') return new AdoClient(baseUrl, token);
  if (connection.kind === 'tangled') return new TangledClient(baseUrl, connection.login || token);
  return new GithubClient(token);
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
