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
  CREATE TABLE review_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    branch_regex TEXT NOT NULL DEFAULT '',
    target_branch TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'pattern',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE review_set_repos (
    review_set_id INTEGER NOT NULL REFERENCES review_sets(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL REFERENCES forge_connections(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    branch TEXT,
    target_branch TEXT,
    PRIMARY KEY (review_set_id, connection_id, repo)
  );
  CREATE TABLE pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_set_id INTEGER NOT NULL REFERENCES review_sets(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );
  CREATE TABLE pull_request_repos (
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    forge_pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pr_id, connection_id, repo)
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_avatar TEXT NOT NULL DEFAULT '',
    connection_id INTEGER,
    repo TEXT,
    path TEXT,
    line INTEGER,
    side TEXT,
    body TEXT NOT NULL,
    synced_at TEXT,
    forge_comment_id TEXT,
    source TEXT NOT NULL DEFAULT 'mureview',
    parent_id INTEGER,
    resolved INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE reviewed_files (
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pr_id, user_id, connection_id, repo, path)
  );
  INSERT INTO users (id, name) VALUES (1, 'legacy');
  INSERT INTO forge_connections (user_id, kind, base_url, access_token, login) VALUES (1, 'github', 'https://github.com', 'old-token', 'account-a');
  INSERT INTO review_set_repos (review_set_id, connection_id, repo) VALUES (1, 1, 'acme/repo');
  PRAGMA user_version = 9;
`);
legacy.close();

process.env.DATABASE_PATH = dbPath;
process.env.SESSION_SECRET = 'test-secret';
