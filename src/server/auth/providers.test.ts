import { expect, test } from 'bun:test';
import { passwordLogin } from './providers';
import { db } from '../db';
import type { Ctx } from '../router';

// The test preload's v9 schema predates identities; the login query needs it.
db.exec(`
  CREATE TABLE IF NOT EXISTS identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    UNIQUE (provider, subject)
  )
`);

function loginRequest(email: string, password: string): Ctx {
  const url = new URL('http://localhost/api/auth/login');
  return {
    req: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
    url,
    path: '/api/auth/login',
    params: {},
    user: null,
  };
}

test('password login stops after repeated failures for one email', async () => {
  const email = `rate-${Date.now()}@example.com`;
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(passwordLogin(loginRequest(email, 'wrong-password'))).rejects.toMatchObject({ status: 401 });
  }
  await expect(passwordLogin(loginRequest(email, 'wrong-password'))).rejects.toMatchObject({ status: 429 });
});
