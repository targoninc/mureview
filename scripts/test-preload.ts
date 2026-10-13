import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';

/**
 * Runs before any test module loads. Tests get their own database so they
 * never touch the development one, and it is created in the previous schema
 * (v9) so the app's migrations run for real during every test run.
 */
const dbPath = `/tmp/opencode/mureview-test-${process.pid}.db`;
for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });

const legacy = new Database(dbPath, { create: true });
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE forge_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL DEFAULT '',
    login TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, kind, base_url)
  );
  CREATE TABLE review_set_repos (
    review_set_id INTEGER NOT NULL,
    connection_id INTEGER NOT NULL REFERENCES forge_connections(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    PRIMARY KEY (review_set_id, connection_id, repo)
  );
  INSERT INTO users (id, name) VALUES (1, 'legacy');
  INSERT INTO forge_connections (user_id, kind, base_url, access_token, login) VALUES (1, 'github', 'https://github.com', 'old-token', 'account-a');
  INSERT INTO review_set_repos (review_set_id, connection_id, repo) VALUES (1, 1, 'acme/repo');
  PRAGMA user_version = 9;
`);
legacy.close();

process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'test-secret';
