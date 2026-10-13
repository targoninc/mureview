import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ForgeKind } from '../shared/types';
import { config } from './config';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath, { create: true });

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export interface UserRow {
  id: number;
  name: string;
  avatar_url: string;
  created_at: string;
}

export interface IdentityRow {
  id: number;
  user_id: number;
  provider: string;
  subject: string;
  display_name: string;
  avatar_url: string;
  password_hash: string | null;
}

export interface ForgeConnectionRow {
  id: number;
  user_id: number;
  kind: ForgeKind;
  base_url: string;
  client_id: string;
  client_secret: string;
  access_token: string;
  /** Encrypted OAuth refresh token, when the forge expires access tokens. */
  refresh_token: string;
  login: string;
  avatar_url: string;
}

const SCHEMA_V2 = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, subject)
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
    UNIQUE (user_id, kind, base_url, login)
  );

  CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'login',
    user_id INTEGER,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE review_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    branch_regex TEXT NOT NULL,
    target_branch TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE review_set_repos (
    review_set_id INTEGER NOT NULL REFERENCES review_sets(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL REFERENCES forge_connections(id) ON DELETE CASCADE,
    repo TEXT NOT NULL,
    PRIMARY KEY (review_set_id, connection_id, repo)
  );

  CREATE TABLE pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_set_id INTEGER NOT NULL REFERENCES review_sets(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_forge ON comments(pr_id, forge_comment_id);

  CREATE TABLE pull_request_repos (
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    forge_pr_ref TEXT NOT NULL,
    head_sha TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pr_id, connection_id, repo)
  );

  CREATE TABLE reviewed_files (
    pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
    connection_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (pr_id, connection_id, repo, path)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE atproto_sessions (
    did TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
  CREATE INDEX IF NOT EXISTS idx_connections_user ON forge_connections(user_id);
  CREATE INDEX IF NOT EXISTS idx_review_sets_owner ON review_sets(owner_id);
  CREATE INDEX IF NOT EXISTS idx_pull_requests_set ON pull_requests(review_set_id);
  CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
`;

function hasTable(name: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function userVersion(): number {
  return db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
}

function createFresh(): void {
  db.exec(SCHEMA_V2);
}

function migrateV1(): void {
  db.exec(`
    CREATE TABLE users_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO users_v2 (id, name, avatar_url, created_at)
      SELECT id, CASE WHEN name <> '' THEN name ELSE login END, avatar_url, created_at FROM users;

    CREATE TABLE identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      password_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (provider, subject)
    );
    INSERT INTO identities (user_id, provider, subject, display_name, avatar_url, created_at)
      SELECT id, 'github', CAST(github_id AS TEXT), login, avatar_url, created_at FROM users;

    CREATE TABLE forge_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users_v2(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      base_url TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '',
      client_secret TEXT NOT NULL DEFAULT '',
      access_token TEXT NOT NULL,
      login TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, kind, base_url)
    );
    INSERT INTO forge_connections (user_id, kind, base_url, client_id, client_secret, access_token, login, avatar_url, created_at)
      SELECT id, 'github', 'https://github.com', '', '', token, login, avatar_url, created_at FROM users;

    CREATE TABLE review_set_repos_v2 (
      review_set_id INTEGER NOT NULL REFERENCES review_sets(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL REFERENCES forge_connections(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      PRIMARY KEY (review_set_id, connection_id, repo)
    );
    INSERT INTO review_set_repos_v2 (review_set_id, connection_id, repo)
      SELECT rsr.review_set_id, fc.id, rsr.repo
      FROM review_set_repos rsr
      JOIN review_sets rs ON rs.id = rsr.review_set_id
      JOIN forge_connections fc ON fc.user_id = rs.owner_id AND fc.kind = 'github';

    ALTER TABLE comments ADD COLUMN connection_id INTEGER;
    UPDATE comments SET connection_id = (
      SELECT fc.id FROM pull_requests p
      JOIN review_sets rs ON rs.id = p.review_set_id
      JOIN forge_connections fc ON fc.user_id = rs.owner_id AND fc.kind = 'github'
      WHERE p.id = comments.pr_id
    );

    ALTER TABLE reviewed_files ADD COLUMN connection_id INTEGER;
    UPDATE reviewed_files SET connection_id = (
      SELECT fc.id FROM pull_requests p
      JOIN review_sets rs ON rs.id = p.review_set_id
      JOIN forge_connections fc ON fc.user_id = rs.owner_id AND fc.kind = 'github'
      WHERE p.id = reviewed_files.pr_id
    );

    CREATE TABLE oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'login',
      user_id INTEGER,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
    CREATE INDEX IF NOT EXISTS idx_connections_user ON forge_connections(user_id);
    CREATE INDEX IF NOT EXISTS idx_review_sets_owner ON review_sets(owner_id);
    CREATE INDEX IF NOT EXISTS idx_pull_requests_set ON pull_requests(review_set_id);
    CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);

    DROP TABLE users;
    ALTER TABLE users_v2 RENAME TO users;
    DROP TABLE review_set_repos;
    ALTER TABLE review_set_repos_v2 RENAME TO review_set_repos;
  `);
}

if (!hasTable('users')) {
  createFresh();
} else if (userVersion() < 2) {
  db.exec('PRAGMA foreign_keys = OFF;');
  const run = db.transaction(() => migrateV1());
  run();
  db.exec('PRAGMA foreign_keys = ON;');
}
if (userVersion() < 3) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_request_repos (
      pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
      connection_id INTEGER NOT NULL,
      repo TEXT NOT NULL,
      forge_pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pr_id, connection_id, repo)
    );
  `);
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(comments)').all();
  if (!columns.some((column) => column.name === 'synced_at')) {
    db.exec('ALTER TABLE comments ADD COLUMN synced_at TEXT');
  }
}
if (userVersion() < 4) {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(comments)').all();
  if (!columns.some((column) => column.name === 'author_name')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE comments_v4 (
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
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO comments_v4 (id, pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, synced_at, source, created_at)
          SELECT c.id, c.pr_id, c.author_id, COALESCE(u.name, ''), COALESCE(u.avatar_url, ''), c.connection_id, c.repo, c.path, c.line, c.side, c.body, c.synced_at, 'mureview', c.created_at
          FROM comments c LEFT JOIN users u ON u.id = c.author_id;
        DROP TABLE comments;
        ALTER TABLE comments_v4 RENAME TO comments;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_forge ON comments(pr_id, forge_comment_id);
      `);
    });
    run();
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
if (userVersion() < 5) {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(comments)').all();
  if (!columns.some((column) => column.name === 'parent_id')) {
    db.exec('ALTER TABLE comments ADD COLUMN parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE');
  }
}
if (userVersion() < 6) {
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(comments)').all();
  if (columns.some((column) => column.name === 'parent_id')) {
    // Deleting a comment must not take other people's replies down with it;
    // they only lose the parent link.
    db.exec('PRAGMA foreign_keys = OFF;');
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE comments_v6 (
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
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          parent_id INTEGER REFERENCES comments_v6(id) ON DELETE SET NULL
        );
        INSERT INTO comments_v6 (id, pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, synced_at, forge_comment_id, source, created_at, parent_id)
          SELECT id, pr_id, author_id, author_name, author_avatar, connection_id, repo, path, line, side, body, synced_at, forge_comment_id, source, created_at, parent_id FROM comments;
        DROP TABLE comments;
        ALTER TABLE comments_v6 RENAME TO comments;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_forge ON comments(pr_id, forge_comment_id);
      `);
    });
    run();
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
if (userVersion() < 7) {
  // Viewed marks become per user (shared review sets), and forge comment
  // threads remember whether they are resolved.
  db.exec('PRAGMA foreign_keys = OFF;');
  const run = db.transaction(() => {
    db.exec(`
      CREATE TABLE reviewed_files_v7 (
        pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id INTEGER NOT NULL,
        repo TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (pr_id, user_id, connection_id, repo, path)
      );
      INSERT INTO reviewed_files_v7 (pr_id, user_id, connection_id, repo, path, created_at)
        SELECT rf.pr_id, r.owner_id, rf.connection_id, rf.repo, rf.path, rf.created_at
        FROM reviewed_files rf
        JOIN pull_requests p ON p.id = rf.pr_id
        JOIN review_sets r ON r.id = p.review_set_id;
      DROP TABLE reviewed_files;
      ALTER TABLE reviewed_files_v7 RENAME TO reviewed_files;
    `);
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(comments)').all();
    if (!columns.some((column) => column.name === 'resolved')) {
      db.exec('ALTER TABLE comments ADD COLUMN resolved INTEGER');
    }
  });
  run();
  db.exec('PRAGMA foreign_keys = ON;');
}
if (userVersion() < 8) {
  // Review sets can pick branches per repository instead of by pattern.
  const setColumns = db.query<{ name: string }, []>('PRAGMA table_info(review_sets)').all();
  if (!setColumns.some((column) => column.name === 'mode')) {
    db.exec("ALTER TABLE review_sets ADD COLUMN mode TEXT NOT NULL DEFAULT 'pattern'");
  }
  const repoColumns = db.query<{ name: string }, []>('PRAGMA table_info(review_set_repos)').all();
  if (!repoColumns.some((column) => column.name === 'branch')) {
    db.exec('ALTER TABLE review_set_repos ADD COLUMN branch TEXT');
  }
  if (!repoColumns.some((column) => column.name === 'target_branch')) {
    db.exec('ALTER TABLE review_set_repos ADD COLUMN target_branch TEXT');
  }
}
if (userVersion() < 9) {
  // Forges with expiring access tokens (GitHub's OAuth apps by default) hand
  // out refresh tokens; keep them so connections stay alive.
  const connectionColumns = db.query<{ name: string }, []>('PRAGMA table_info(forge_connections)').all();
  if (!connectionColumns.some((column) => column.name === 'refresh_token')) {
    db.exec("ALTER TABLE forge_connections ADD COLUMN refresh_token TEXT NOT NULL DEFAULT ''");
  }
}
if (userVersion() < 10) {
  // Several accounts per forge are allowed now, so a connection is unique per
  // account rather than per forge.
  const definition =
    db
      .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'forge_connections'")
      .get()?.sql ?? '';
  if (!definition.includes('base_url, login')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE forge_connections_v10 (
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
          UNIQUE (user_id, kind, base_url, login)
        );
        INSERT INTO forge_connections_v10 (id, user_id, kind, base_url, client_id, client_secret, access_token, refresh_token, login, avatar_url, created_at)
          SELECT id, user_id, kind, base_url, client_id, client_secret, access_token, refresh_token, login, avatar_url, created_at FROM forge_connections;
        DROP TABLE forge_connections;
        ALTER TABLE forge_connections_v10 RENAME TO forge_connections;
        CREATE INDEX IF NOT EXISTS idx_connections_user ON forge_connections(user_id);
      `);
    });
    run();
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
if (userVersion() < 11) {
  // Tangled names pull requests with record keys rather than numbers, so the
  // reference is text everywhere. Atproto sessions are kept so service-auth
  // tokens can be minted for Tangled after a restart.
  db.exec(`
    CREATE TABLE IF NOT EXISTS atproto_sessions (
      did TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const repoColumns = hasTable('pull_request_repos')
    ? db.query<{ name: string }, []>('PRAGMA table_info(pull_request_repos)').all()
    : [];
  if (repoColumns.length && !repoColumns.some((column) => column.name === 'forge_pr_ref')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    const run = db.transaction(() => {
      db.exec(`
        CREATE TABLE pull_request_repos_v11 (
          pr_id INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
          connection_id INTEGER NOT NULL,
          repo TEXT NOT NULL,
          forge_pr_ref TEXT NOT NULL,
          head_sha TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (pr_id, connection_id, repo)
        );
        INSERT INTO pull_request_repos_v11 (pr_id, connection_id, repo, forge_pr_ref, head_sha, created_at)
          SELECT pr_id, connection_id, repo, CAST(forge_pr_number AS TEXT), head_sha, created_at FROM pull_request_repos;
        DROP TABLE pull_request_repos;
        ALTER TABLE pull_request_repos_v11 RENAME TO pull_request_repos;
      `);
    });
    run();
    db.exec('PRAGMA foreign_keys = ON;');
  }
}
db.exec('PRAGMA user_version = 11;');

export function getSetting(key: string): string | null {
  const row = db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}
