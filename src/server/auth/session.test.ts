import { expect, test } from 'bun:test';
import { db } from '../db';
import { getSessionUser, startSession } from './session';

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

test('new session tokens are stored hashed and legacy tokens still work', () => {
  const cookie = startSession(1);
  const token = /mureview_sid=([^;]+)/.exec(cookie)?.[1];
  expect(token).toBeTruthy();
  const stored = db.query<{ token: string }, []>('SELECT token FROM sessions WHERE user_id = 1 ORDER BY rowid DESC LIMIT 1').get();
  expect(stored?.token.startsWith('sha256:')).toBe(true);
  expect(getSessionUser(new Request('http://localhost/', { headers: { cookie: `mureview_sid=${token}` } }))?.id).toBe(1);

  db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('legacy-token', 1, datetime('now', '+1 day'))");
  expect(getSessionUser(new Request('http://localhost/', { headers: { cookie: 'mureview_sid=legacy-token' } }))?.id).toBe(1);
});
