import type { AuthProvider } from '../../shared/types';
import { decrypt, encrypt, randomToken } from '../crypto';
import { db } from '../db';

export type OAuthMode = 'login' | 'connect';

const encryptedPayloadPrefix = 'enc:v1:';

interface StateRow {
  state: string;
  provider: string;
  mode: string;
  user_id: number | null;
  payload: string;
  expires_at: string;
}

export interface PendingAuth {
  provider: AuthProvider;
  mode: OAuthMode;
  userId: number | null;
  payload: Record<string, string>;
}

export function createState(input: { provider: AuthProvider; mode: OAuthMode; userId?: number; payload?: Record<string, string> }): string {
  const state = randomToken(24);
  db.run('DELETE FROM oauth_states WHERE expires_at < datetime(\'now\')');
  db.run(
    `INSERT INTO oauth_states (state, provider, mode, user_id, payload, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+15 minutes'))`,
    [state, input.provider, input.mode, input.userId ?? null, `${encryptedPayloadPrefix}${encrypt(JSON.stringify(input.payload ?? {}))}`],
  );
  return state;
}

export function takeState(state: string, provider: AuthProvider): PendingAuth {
  const row = db
    .query<StateRow, [string, string]>(`SELECT * FROM oauth_states WHERE state = ? AND provider = ? AND expires_at > datetime('now')`)
    .get(state, provider);
  if (!row) throw new Error('This sign-in attempt expired or was already used. Please try again.');
  db.run('DELETE FROM oauth_states WHERE state = ?', [state]);
  return {
    provider,
    mode: row.mode === 'connect' ? 'connect' : 'login',
    userId: row.user_id,
    payload: JSON.parse(
      row.payload.startsWith(encryptedPayloadPrefix) ? decrypt(row.payload.slice(encryptedPayloadPrefix.length)) : row.payload,
    ) as Record<string, string>,
  };
}
