import type { AuthProvider, ForgeKind } from '../../shared/types';
import { encrypt } from '../crypto';
import { type ForgeConnectionRow, type IdentityRow, type UserRow, db } from '../db';
import { hostOf, organizationOf } from '../forges';

export interface IdentityProfile {
  provider: AuthProvider;
  subject: string;
  displayName: string;
  avatarUrl: string;
  passwordHash?: string;
}

export interface ConnectionInput {
  kind: ForgeKind;
  baseUrl: string;
  clientId?: string;
  clientSecret?: string;
  accessToken: string;
  refreshToken?: string;
  login: string;
  avatarUrl?: string;
}

export function userById(id: number): UserRow | null {
  return db.query<UserRow, [number]>('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function findUserByIdentity(provider: AuthProvider, subject: string): UserRow | null {
  return (
    db
      .query<UserRow, [string, string]>(
        'SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?',
      )
      .get(provider, subject) ?? null
  );
}

export function identitiesFor(userId: number): IdentityRow[] {
  return db.query<IdentityRow, [number]>('SELECT * FROM identities WHERE user_id = ? ORDER BY id').all(userId);
}

function createUser(profile: { displayName: string; avatarUrl: string }): UserRow {
  const inserted = db.run('INSERT INTO users (name, avatar_url) VALUES (?, ?)', [profile.displayName, profile.avatarUrl]);
  return userById(Number(inserted.lastInsertRowid))!;
}

export function addIdentity(userId: number, profile: IdentityProfile): void {
  db.run(
    'INSERT INTO identities (user_id, provider, subject, display_name, avatar_url, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, profile.provider, profile.subject, profile.displayName, profile.avatarUrl, profile.passwordHash ?? null],
  );
}

export function updateIdentity(identityId: number, profile: Pick<IdentityProfile, 'displayName' | 'avatarUrl'>): void {
  db.run('UPDATE identities SET display_name = ?, avatar_url = ? WHERE id = ?', [profile.displayName, profile.avatarUrl, identityId]);
}

export function loginOrCreate(profile: IdentityProfile): { user: UserRow; mergedFrom: UserRow | null } {
  const existing = findUserByIdentity(profile.provider, profile.subject);
  if (existing) {
    updateIdentityForLogin(existing.id, profile);
    return { user: existing, mergedFrom: null };
  }
  const user = createUser(profile);
  addIdentity(user.id, profile);
  return { user, mergedFrom: null };
}

function updateIdentityForLogin(userId: number, profile: IdentityProfile): void {
  db.run('UPDATE identities SET display_name = ?, avatar_url = ? WHERE user_id = ? AND provider = ? AND subject = ?', [
    profile.displayName,
    profile.avatarUrl,
    userId,
    profile.provider,
    profile.subject,
  ]);
}

export function upsertConnection(userId: number, input: ConnectionInput): ForgeConnectionRow {
  const baseUrl = input.baseUrl.replace(/\/+$/, '');
  const existing = db
    .query<ForgeConnectionRow, [number, string, string]>('SELECT * FROM forge_connections WHERE user_id = ? AND kind = ? AND base_url = ?')
    .get(userId, input.kind, baseUrl);

  const values = [
    input.clientId ?? existing?.client_id ?? '',
    input.clientSecret ? encrypt(input.clientSecret) : (existing?.client_secret ?? ''),
    encrypt(input.accessToken),
    input.refreshToken ? encrypt(input.refreshToken) : (existing?.refresh_token ?? ''),
    input.login,
    input.avatarUrl ?? existing?.avatar_url ?? '',
  ];

  if (existing) {
    db.run(
      'UPDATE forge_connections SET client_id = ?, client_secret = ?, access_token = ?, refresh_token = ?, login = ?, avatar_url = ? WHERE id = ?',
      [...values, existing.id],
    );
    return db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(existing.id)!;
  }

  const inserted = db.run(
    'INSERT INTO forge_connections (user_id, kind, base_url, client_id, client_secret, access_token, refresh_token, login, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, input.kind, baseUrl, ...values],
  );
  return db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(Number(inserted.lastInsertRowid))!;
}

export function connectionsFor(userId: number): ForgeConnectionRow[] {
  return db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE user_id = ? ORDER BY kind, base_url').all(userId);
}

export function connectionById(userId: number, id: number): ForgeConnectionRow | null {
  return (
    db.query<ForgeConnectionRow, [number, number]>('SELECT * FROM forge_connections WHERE user_id = ? AND id = ?').get(userId, id) ?? null
  );
}

export function connectionLabel(connection: ForgeConnectionRow): string {
  return `${hostOf(connection.base_url)}/${connection.login}`;
}

/**
 * The user's own connection to the same forge and organization as another
 * connection (used to act on shared review sets with one's own credentials).
 */
export function matchingConnection(userId: number, owner: ForgeConnectionRow): ForgeConnectionRow | null {
  const host = hostOf(owner.base_url);
  const org = organizationOf(owner.base_url);
  return (
    connectionsFor(userId).find(
      (candidate) =>
        candidate.kind === owner.kind &&
        hostOf(candidate.base_url) === host &&
        (org === null || organizationOf(candidate.base_url) === org),
    ) ?? null
  );
}

/** A connection the user may act with: their own, or their matching one. */
export function connectionOrMatching(userId: number, connectionId: number): ForgeConnectionRow | null {
  const own = connectionById(userId, connectionId);
  if (own) return own;
  const owner = db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE id = ?').get(connectionId);
  return owner ? matchingConnection(userId, owner) : null;
}

export function mergeUsers(fromId: number, intoId: number): void {
  if (fromId === intoId) return;
  const apply = db.transaction(() => {
    db.run('UPDATE review_sets SET owner_id = ? WHERE owner_id = ?', [intoId, fromId]);
    db.run('UPDATE comments SET author_id = ? WHERE author_id = ?', [intoId, fromId]);

    const connections = db.query<ForgeConnectionRow, [number]>('SELECT * FROM forge_connections WHERE user_id = ?').all(fromId);
    for (const connection of connections) {
      const existing = db
        .query<ForgeConnectionRow, [number, string, string]>('SELECT * FROM forge_connections WHERE user_id = ? AND kind = ? AND base_url = ?')
        .get(intoId, connection.kind, connection.base_url);
      if (existing) {
        db.run('UPDATE OR IGNORE review_set_repos SET connection_id = ? WHERE connection_id = ?', [existing.id, connection.id]);
        db.run('DELETE FROM review_set_repos WHERE connection_id = ?', [connection.id]);
        db.run('DELETE FROM forge_connections WHERE id = ?', [connection.id]);
      } else {
        db.run('UPDATE forge_connections SET user_id = ? WHERE id = ?', [intoId, connection.id]);
      }
    }

    db.run('UPDATE identities SET user_id = ? WHERE user_id = ?', [intoId, fromId]);
    db.run('DELETE FROM sessions WHERE user_id = ?', [fromId]);
    db.run('DELETE FROM users WHERE id = ?', [fromId]);
  });
  apply();
}
