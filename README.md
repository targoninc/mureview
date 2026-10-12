<img src="assets/icon.svg" width="64" height="64" alt="">

# mureview

Multi-repository code review. A **review set** groups repositories with a branch
pattern; mureview finds the matching branch in each repository and renders one
fake pull request that diffs every matched branch against a shared target
branch.

Built with [Bun](https://bun.sh), [React](https://react.dev),
[Primer](https://primer.style) (the GitHub design system),
[Diffs](https://diffs.com) and [Trees](https://trees.software).

## How it works

- Sign in with GitHub (OAuth, `repo read:user`).
- Create a **review set**: a name, a list of repositories you have access to, a
  branch pattern (regular expression) and a target branch.
- The pattern must match **at most one branch per repository** (0 or 1). If it
  matches more, the UI shows an **invalid configuration** banner explaining
  which repository and branches are the problem. Repositories you cannot access
  are reported the same way.
- Matched branches are compared against the target branch for each repository.
  If the target branch does not exist, it is treated as empty, so every file on
  the matched branch shows up as an addition (the fake PR "creates" it).
- Comment on specific code lines (hover the line gutter) or in the general
  conversation. Comments are stored in SQLite **only while the PR is open**.
  Once the matched branches are merged into the target (or all disappear), the
  PR is closed and its comments are discarded — the PR is ephemeral.
- Mark files as viewed from the checkbox in each file header, or right-click a
  file in the tree. Viewed files show a green check in the tree and a
  `x/y viewed` counter in the header; the marks are ephemeral like comments.
- Merge the whole review: each matched branch is merged into the target on
  GitHub (the target is created when missing) behind a confirmation dialog.
  When every branch is merged the PR closes automatically.

Data is stored in a single SQLite database. Everything is scoped to the signed-in
owner: users only ever see their own review sets, and every GitHub request uses
their own token.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8081` | Public URL. Used for OAuth redirects and may include a path prefix. |
| `GITHUB_CLIENT_ID` | | GitHub OAuth app client id. |
| `GITHUB_CLIENT_SECRET` | | GitHub OAuth app client secret. |
| `SESSION_SECRET` | generated & stored in DB | Optional override for session/token encryption. |
| `PORT` | `8081` | HTTP port. |
| `DATABASE_PATH` | `data/mureview.db` | SQLite file location. |

Create an OAuth app at <https://github.com/settings/developers> with the callback
URL set to `${BASE_URL}/api/auth/callback`.

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
