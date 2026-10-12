<img src="assets/icon.svg" width="64" height="64" alt="">

# mureview

Multi-forge code review. A **review set** groups repositories (GitHub, Forgejo
or Azure DevOps, mixed freely) with a branch pattern; mureview finds the
matching branch in each repository and renders one fake pull request that diffs
every matched branch against a shared target branch.

Built with [Bun](https://bun.sh), [React](https://react.dev),
[Primer](https://primer.style) (the GitHub design system) and
[Diffs](https://diffs.com).

## How it works

- Sign in with GitHub, [Forgejo](https://forgejo.org/) (OAuth2), atproto, or
  email + password. All four end up in one account: sign-in methods and forge
  connections are separate, and connecting a forge identity that already
  belongs to another account merges that account's data into yours.
- Forgejo is connected per user: register an OAuth2 application on your
  instance (Settings → Applications) with the callback URL
  `${BASE_URL}/api/auth/callback/forgejo` and paste its client id/secret into
  mureview. GitHub uses a server-wide OAuth app (see below); atproto needs no
  configuration, but `${BASE_URL}/oauth-client-metadata.json` must be publicly
  reachable. Azure DevOps is connected with a personal access token (Code:
  read & write, Project and Team: read) — it is a forge connection, so sign in
  with one of the other providers and add it under Settings.
- Create a **review set**: a name, repositories picked with a search across all
  your connected forges, a branch pattern (regular expression) and a target
  branch. Review sets can mix repositories from different forges.
- The pattern must match **at most one branch per repository** (0 or 1). If it
  matches more, the UI shows an **invalid configuration** banner explaining
  which repository and branches are the problem. Repositories you cannot access
  are reported the same way.
- Matched branches are compared against the target branch for each repository
  (GitHub's compare API; for Forgejo, patches are generated from the two trees).
  If the target branch does not exist, it is treated as empty, so every file on
  the matched branch shows up as an addition (the fake PR "creates" it).
- Comment on specific code lines (hover the line gutter) or in the general
  conversation. Comments are stored in SQLite **only while the PR is open**.
  Once the matched branches are merged into the target (or all disappear), the
  PR is closed and its comments are discarded — the PR is ephemeral.
- Mark files as viewed from the checkbox on each file row in the sidebar tree,
  or the Viewed checkbox in the file's diff header. The header shows an
  `x/y viewed` counter; the marks are ephemeral like comments.
- Merge the whole review: each matched branch is merged into the target on
  GitHub (the target is created when missing) behind a confirmation dialog.
  When every branch is merged the PR closes automatically.

Data is stored in a single SQLite database (migrated automatically on start).
Everything is scoped to the signed-in owner: users only ever see their own
review sets, and every forge request uses their own connection tokens.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8081` | Public URL. Used for OAuth redirects and may include a path prefix. |
| `GITHUB_CLIENT_ID` | | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | | GitHub OAuth app client secret. |
| `GITHUB_REDIRECT_URI` | `${BASE_URL}/api/auth/callback/github` | Override when the OAuth app has a different callback URL registered. |
| `SESSION_SECRET` | generated & stored in DB | Optional override for session/token encryption. |
| `PORT` | `8081` | HTTP port. |
| `DATABASE_PATH` | `data/mureview.db` | SQLite file location. |

Create an OAuth app at <https://github.com/settings/developers> with the callback
URL set to `${BASE_URL}/api/auth/callback/github`. GitHub sign-in and
connections are optional: without credentials the other providers still work.
If your app still has the legacy `${BASE_URL}/api/auth/callback` registered
(that route is still served), set `GITHUB_REDIRECT_URI` to it so the authorize
request uses the URL GitHub knows.

## Development

```bash
bun install
cp .env.example .env   # fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
bun run dev            # server on :8081, Vite on :5173 (proxies /api)
```

Other scripts: `bun run build`, `bun run start-prod`, `bun run typecheck`,
`bun test`.

## Docker

```bash
docker build -t mureview .
docker run -p 8081:8081 \
  -e BASE_URL=https://mureview.example.com \
  -e GITHUB_CLIENT_ID=... \
  -e GITHUB_CLIENT_SECRET=... \
  -v mureview-data:/usr/src/app/data \
  mureview
```

## Layout

```
src/server   Bun HTTP server: auth, review sets, validation, fake PRs, comments
src/client   React app (pages, PR view, comments, file tree)
src/shared   Types shared by both sides
```
