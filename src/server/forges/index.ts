import type { ForgeConnectionRow } from '../db';
import { decrypt } from '../crypto';
import { ForgejoClient, invalidateForgejoBranchCaches } from './forgejo';
import { GithubClient, invalidateGithubBranchCaches } from './github';
import type { ForgeClient } from './types';

export function clientFor(connection: ForgeConnectionRow): ForgeClient {
  const token = decrypt(connection.access_token);
  return connection.kind === 'forgejo' ? new ForgejoClient(connection.base_url, token) : new GithubClient(token);
}

export function connectionSecret(connection: ForgeConnectionRow): string {
  return connection.client_secret ? decrypt(connection.client_secret) : '';
}

export function invalidateForgeCaches(): void {
  invalidateGithubBranchCaches();
  invalidateForgejoBranchCaches();
}

export * from './types';
