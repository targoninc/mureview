<img src="assets/icon.svg" width="64" height="64" alt="">

# mureview

Multi-forge code review. A **review set** groups repositories (GitHub, Forgejo,
Azure DevOps or [Tangled](https://tangled.org), mixed freely) with a branch
pattern; mureview finds the matching branch in each repository and renders one
fake pull request that diffs every matched branch against a shared target
branch.

Built with [Bun](https://bun.sh), [React](https://react.dev),
[Primer](https://primer.style) (the GitHub design system) and
[Diffs](https://diffs.com).

## How it works

- Sign in with GitHub, [Forgejo](https://forgejo.org/) (OAuth2), atproto, or
  email + password. All four end up in one account: sign-in methods and forge
  connections are separate, and connecting a forge identity that already
  belongs to another account merges that account's data into yours.
- Several accounts per forge are fine (for example two GitHub accounts):
  repositories from all of them show up in the review set search.
- Forgejo is connected per user: register an OAuth2 application on your
  instance (Settings → Applications) with the callback URL
  `${BASE_URL}/api/auth/callback/forgejo` and paste its client id/secret into
  mureview. GitHub uses a server-wide OAuth app (see below); atproto needs no
  configuration, but `${BASE_URL}/oauth-client-metadata.json` must be publicly
  reachable. Azure DevOps is connected with a personal access token (Code:
  read & write, Project and Team: read) — it is a forge connection, so sign in
  with one of the other providers and add it under Settings. Tangled is
  connected with the atproto handle that owns the repositories; mureview reads
  them from the knot hosting each one, so no token is needed (pull requests,
  comments and merging on Tangled are not supported yet).
- Create a **review set**: a name, repositories picked with a search across all
  your connected forges, one or more branch patterns (regular expressions,
  separated by commas) and a target branch. Review sets can mix repositories
  from different forges.
- The patterns together must match **at most one branch per repository** (0 or
  1) — list one pattern per branch you want to target, e.g.
  `^main$, ^release/v\d+$`. If a repository matches more, the UI shows an
  **invalid configuration** banner explaining which repository and branches are
  the problem. Repositories you cannot access are reported the same way.
- Matched branches are compared against the target branch for each repository
  (GitHub's compare API; the knot's own compare for Tangled; for Forgejo,
  patches are generated from the two trees).
  If the target branch does not exist, it is treated as empty, so every file on
  the matched branch shows up as an addition (the fake PR "creates" it).
- Comment on specific code lines (hover the line gutter) or in the general
  conversation; each discussion has a single reply box at the bottom. Comments
  that exist on the forge pull request are imported into mureview and mirrored
  back to it, so both sides stay in sync (including deletes). Comments are
  stored in SQLite **only while the PR is open**. Once the matched branches are
  merged into the target (or all disappear), the PR is closed and its comments
  are discarded — the PR is ephemeral.
- Mark files as viewed from the checkbox on each file row in the sidebar tree,
  or the Viewed checkbox in the file's diff header. The header shows an
  `x/y viewed` counter; the marks are ephemeral like comments.
- Merge the whole review: each matched branch is merged into the target on its
  forge (the target branch is created when missing) behind a confirmation
  dialog, blocked while checks fail or conflicts are detected. When every
  branch is merged the PR closes automatically.

Data is stored in a single SQLite database (migrated automatically on start).
Everything is scoped to the signed-in owner and forge actions use the acting
user's own connection tokens. A review set also shows up for other users, under
"Review sets from others", when they can reach **every** repository in it with
their own connections; otherwise it stays invisible. Anyone whose own accounts
may merge every branch in a shared set can also change its settings, refresh it
and merge — always with their own credentials, never the owner's. Everyone else
gets a read-only view. Anyone with access can comment — as themselves, on
mureview and on the forge — and viewed marks are personal. A comment can only be
deleted by its own author, so the two sides cannot drift apart.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8081` | Public URL. Used for OAuth redirects and may include a path prefix. |
| `GITHUB_CLIENT_ID` | | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | | GitHub OAuth app client secret. |
| `GITHUB_REDIRECT_URI` | `${BASE_URL}/api/auth/callback/github` | Override when the OAuth app has a different callback URL registered. |
| `GITHUB_APP_ID` | | GitHub App id (optional, see below). |
| `GITHUB_APP_PRIVATE_KEY` | | GitHub App private key. PEM, PEM with `\n` escapes, or base64-encoded (`base64 -w0 key.pem`). |
| `GITHUB_APP_WEBHOOK_SECRET` | | GitHub App webhook secret, for verifying its deliveries. |
| `GITHUB_APP_SLUG` | resolved from GitHub | GitHub App slug (the `/settings/apps/<slug>` path segment), only to skip the startup lookup. |
| `ENTRA_CLIENT_ID` | | Microsoft Entra ID app client id (optional sign-in method). |
| `ENTRA_CLIENT_SECRET` | | Microsoft Entra ID app client secret. |
| `ENTRA_TENANT` | `common` | Entra tenant: `common`, `organizations`, `consumers` or a tenant id. |
| `SESSION_SECRET` | generated & stored in DB | Optional override for session/token encryption. |
| `PORT` | `8081` | HTTP port. |
| `DATABASE_PATH` | `data/mureview.db` | SQLite file location. |

Create an OAuth app at <https://github.com/settings/developers> with the callback
URL set to `${BASE_URL}/api/auth/callback/github`. For Entra ID sign-in,
register an app at <https://entra.microsoft.com> with the redirect URI
`${BASE_URL}/api/auth/callback/entra` and set `ENTRA_CLIENT_ID` /
`ENTRA_CLIENT_SECRET`. GitHub sign-in and connections are optional: without
credentials the other providers still work.
If your app still has the legacy `${BASE_URL}/api/auth/callback` registered
(that route is still served), set `GITHUB_REDIRECT_URI` to it so the authorize
request uses the URL GitHub knows.

### GitHub App (optional)

A GitHub App is not required, but it makes two things better: mureview uses
short-lived installation tokens instead of the account's OAuth token, and one
webhook endpoint covers every installed repository, so comments, reviews and
pull request changes made on GitHub reach open mureview sessions without
polling. Existing installations migrate by adding the variables below and
installing the app — without them, nothing changes.

1. Create an app at <https://github.com/settings/apps/new>.
   - **Homepage URL**: `${BASE_URL}`
   - **Callback URL**: `${BASE_URL}/api/auth/callback/github`
   - **Webhook URL**: `${BASE_URL}/api/webhooks/github-app`
   - **Webhook secret**: any random string, also set as
     `GITHUB_APP_WEBHOOK_SECRET`.
   - **Setup URL** (optional): `${BASE_URL}/settings`.
   - **Repository permissions**: Metadata (read, mandatory), Contents (read),
     Pull requests (write, for merging and reviews), Issues (write, for
     general pull request comments), Checks (read), Commit statuses (read).
   - **Subscribe to events**: Pull request, Pull request review, Issue
     comment, Installation, Installation repositories and Delete (branch
     deletions change what a review set can still compare). Everything else
     is acknowledged and ignored.
   - *Request user authorization (OAuth) during installation*: checking it
     sends the user through the callback above, so installing also signs them
     in and creates their GitHub connection in one step. Leaving it off works
     too — mureview learns installations from the webhook and, when someone
     connects GitHub later, looks up their installation.
2. Generate a private key on the app page and set `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET`. The slug for
   the settings install link is read from GitHub on startup; set
   `GITHUB_APP_SLUG` only to skip that lookup.
3. Restart mureview and install the app on the account or organization whose
   repositories you review. The installation attaches itself to the matching
   connections; per-repository webhooks are skipped from then on because the
   app delivers them already.

The app's client id and secret can also be used as `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET` for sign-in — the OAuth flow is the same. Running both
an OAuth app for sign-in and the GitHub App for installations is fine too.

### Live updates without the GitHub App

Forgejo and GitHub connections without an installation register per-repository
webhooks automatically when the acting token may manage them; otherwise the
registration is logged and skipped, and mureview keeps polling. Azure DevOps
service hooks have to be created by hand (project settings → Service hooks →
Web Hooks): the URL is `${BASE_URL}/api/webhooks/forge/<connectionId>` and the
basic auth password must be the connection's webhook secret, which mureview
generates on first use and stores in the database:

```sql
SELECT id, kind, login, webhook_secret FROM forge_connections;
```

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
src/server   Bun HTTP server: auth, forge clients, review sets, validation,
             fake PRs, comment sync, merges
src/client   React app (pages, PR view, comments, file tree)
src/shared   Types shared by both sides
```
