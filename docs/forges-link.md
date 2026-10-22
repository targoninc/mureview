# forges.link evaluation

Date: 2026-10-22. Status: reviewed, not planned for now.

Verdict: not a drop-in replacement for `src/server/forges`. It is a good fit for
GitHub, Forgejo and Tangled, but Azure DevOps would stay custom.

## What maps well

- `contents.compare()` returns changed files with patches and `mergeBaseSha`;
  `contents.getFile({ ref })` reads blobs at any revision.
- Pull requests: get/list/create/update/merge, files, commits, reviews with
  inline comments, review-thread resolution, checks, comments, reviewer requests.
- `repos.permissionFor()`, GitHub App auth (`installations.list/token`), webhook
  create/verify/ingest with normalized events, self-hosted `baseUrl`.
- `provider.request()` is an escape hatch for endpoints the model does not cover.

## Where it falls short

- Azure DevOps: `threads.files`, `threads.commits`, `contents.compare` and
  `repos.permissionFor` are unsupported, and reviews are only emulated. The diff
  screen and merge preview depend on these, so `ado.ts` cannot be removed.
- No branch delete and no pull request retarget. `merge.ts` uses both for stack
  cleanup and stacked merges; they would need raw requests per forge.
- `Installation` carries no permission details, so
  `installationCanManagePullRequests` stays custom.
- mureview still owns caching, account-first/installation-fallback routing,
  permission gates, conflict preview and webhook-driven mark resets.

## Cost

About 3.7k lines of forge clients and 1.2k lines of forge tests would become
adapters plus rewritten tests. Expect a moderate reduction for GitHub, Forgejo
and Tangled, and no reduction for Azure DevOps.

## Recommendation

If revisited, pilot one forge (Forgejo, which has a local fake harness) or adopt
only `webhooks.ingest()` first. Do not start with Azure DevOps.
