export type ForgeKind = 'github' | 'forgejo' | 'ado' | 'tangled';

/** The acting user's decision on a pull request. */
export type ReviewVote = 'approve' | 'waiting' | 'reject';

export type AuthProvider = 'github' | 'forgejo' | 'atproto' | 'email' | 'entra';

export interface McpKey {
  id: number;
  prefix: string;
  clientName: string | null;
  createdAt: string;
  usedAt: string;
  lastUsedAt: string;
}

export interface User {
  id: number;
  name: string;
  avatarUrl: string;
  /** Bundled monospace font id; null means the default. */
  monoFont: string | null;
  /** The text size of diffs, in pixels. */
  diffFontSize: number;
  /** Mark files as viewed once they were fully seen; see useAutoViewed. */
  autoMarkViewed: boolean;
  /** Hide viewed files from the file tree. */
  hideViewedFiles: boolean;
}

export interface IdentityInfo {
  id: number;
  provider: AuthProvider;
  displayName: string;
}

export interface ForgeConnectionInfo {
  id: number;
  kind: ForgeKind;
  baseUrl: string;
  host: string;
  org: string | null;
  login: string;
  avatarUrl: string;
  manageUrl: string | null;
  /** For Tangled: whether an atproto sign-in exists to write with. */
  writeReady?: boolean;
}

export interface CommentInput {
  connectionId: number | null;
  repo: string | null;
  position?: number;
  path: string | null;
  login: string;
  avatarUrl: string;
  manageUrl: string | null;
}

export interface MeResponse {
  user: User | null;
  identities: IdentityInfo[];
  connections: ForgeConnectionInfo[];
  providers: AuthProvider[];
  githubOAuthAppUrl: string | null;
  /** The GitHub App's slug, when the installation offers one. */
  githubAppSlug: string | null;
  /** The app's installations on GitHub, when the app is configured. */
  githubInstallations: Array<{
    id: number;
    account: string;
    selection: string;
    organization: boolean;
    /** The granted permissions, to spot what merging still needs. */
    contentsWrite: boolean;
    pullRequestsWrite: boolean;
  }>;
}

export interface TokenWarning {
  connectionId: number;
  kind: ForgeKind;
  message: string;
  displayName: string;
  validTo: string;
  daysLeft: number;
}

export type LoadPhase = 'pending' | 'checking' | 'diffing' | 'done' | 'error';

export interface RefInfo {
  url: string;
  title: string;
  kind: 'pr' | 'issue' | 'work';
}

export interface LoadProgressRepo {
  label: string;
  phase: LoadPhase;
}

export interface LoadProgress {
  repos: LoadProgressRepo[];
  done: number;
  total: number;
  finished: boolean;
}

export type ReviewSetMode = 'pattern' | 'per-repo' | 'stack';

export interface ReviewSetRepo {
  connectionId: number;
  repo: string;
  kind: ForgeKind;
  host: string;
  org: string | null;
  /** Selected source branch in per-repo and stack modes. */
  branch: string | null;
  /** Selected target branch in per-repo mode; the layer below in stack mode. */
  target: string | null;
  /** The layer of a stack; 0 for pattern and per-repo review sets. */
  position: number;
}

export interface ReviewSet {
  id: number;
  name: string;
  repos: ReviewSetRepo[];
  mode: ReviewSetMode;
  branchRegex: string;
  targetBranch: string;
  createdAt: string;
  /** Set when the review set belongs to someone else. */
  owner?: { name: string; avatarUrl: string } | null;
}

export interface ReviewSetInput {
  name: string;
  repos: { connectionId: number; repo: string; branch?: string | null; target?: string | null; position?: number }[];
  mode: ReviewSetMode;
  branchRegex: string;
  targetBranch: string;
}

export interface RepoSource {
  /** Identifies the source; one connection may offer several (GitHub App installations). */
  id: string;
  connectionId: number;
  kind: ForgeKind;
  host: string;
  org: string | null;
  login: string;
  label: string;
}

export interface AvailableRepo {
  /** The source this repository belongs to (see RepoSource.id). */
  sourceId: string;
  connectionId: number;
  repo: string;
  kind: ForgeKind;
  host: string;
  org: string | null;
  login: string;
  sourceLabel: string;
  private: boolean;
}

export interface RepoSearchResponse {
  repos: AvailableRepo[];
  sources: RepoSource[];
  errors: { connectionId: number; message: string }[];
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'changed';

export interface FileDiff {
  path: string;
  prevPath?: string;
  type: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

export type RepoPrState = 'no-match' | 'merged' | 'open' | 'error';

export interface RepoStatus {
  connectionId: number;
  kind: ForgeKind;
  host: string;
  org: string | null;
  repo: string;
  accessible: boolean;
  error?: string;
  matches: string[];
  branch: string | null;
  /** The branch the matched branch is compared against. */
  target: string;
  /** The layer of a stack this entry is; 0 otherwise. */
  position: number;
  /** A note about a collapsed or missing layer, for the review page. */
  note?: string;
  targetExists: boolean;
  state: RepoPrState;
  aheadBy?: number;
  behindBy?: number;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  headSha?: string;
  pullRequest?: {
    ref: string;
    url: string;
    review?: ReviewVote | null;
    /** The pull request's state on the forge. */
    state?: 'open' | 'closed' | 'merged';
    /** Where the forge says the pull request points now. */
    head?: string;
    base?: string;
    /** Everyone's decisions, when the forge reports them. */
    reviewers?: Array<{ name: string; avatarUrl?: string; vote: ReviewVote; you?: boolean }>;
  };
  /** Why creating the forge pull request failed, when it did. */
  prError?: string;
  commits?: CommitInfo[];
  commitsTruncated?: boolean;
  files?: FileDiff[];
}

export type PrLifecycle = 'loading' | 'invalid' | 'empty' | 'open' | 'closed';

export interface Comment {
  id: number;
  prId: number;
  author: { name: string; avatarUrl: string };
  /** The mureview user who wrote the comment; null for imported forge comments. */
  authorId: number | null;
  connectionId: number | null;
  repo: string | null;
  position: number;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  body: string;
  synced: boolean;
  source: 'mureview' | 'forge';
  forgeCommentId: string | null;
  parentId: number | null;
  /** Resolved state of the forge thread; null when there is no forge thread. */
  resolved: boolean | null;
  createdAt: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string;
  url?: string;
}

export interface CommentInput {
  connectionId: number | null;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  body: string;
  parentId?: number | null;
}

export interface ReviewMark {
  connectionId: number;
  repo: string;
  position: number;
  path: string;
}

/** A file one user marked as viewed, for showing who reviewed what. */
export interface ReviewMarkBy extends ReviewMark {
  user: { id: number; name: string; avatarUrl: string };
}

export interface PrStatus {
  state: PrLifecycle;
  errors: string[];
  repos: RepoStatus[];
  /** For stacked review sets: one cumulative diff per repository (position -1). */
  combined?: RepoStatus[];
  prId: number | null;
  comments: Comment[];
  reviewed: ReviewMark[];
  /** Who marked what as viewed, for the avatars in the file headers. */
  reviewedBy: ReviewMarkBy[];
  stats: { repos: number; files: number; additions: number; deletions: number };
}

export interface ReviewSetDetail {
  reviewSet: ReviewSet;
  pr: PrStatus;
  /** False when the review set belongs to another user and is only readable. */
  owned: boolean;
  owner: { name: string; avatarUrl: string } | null;
  /** Whether the viewer may merge every branch, and so change settings or refresh. */
  canManage: boolean;
}

export interface MergeResult {
  connectionId: number;
  label: string;
  ok: boolean;
  message: string;
  /** The pull requests that ended up merged for this repository. */
  mergedPrs: number;
}

export type ConflictState = 'none' | 'detected' | 'unknown';

export interface CheckInfo {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped' | 'unknown';
  description?: string;
  url?: string;
}

export interface ChecksSummary {
  state: 'none' | 'pending' | 'success' | 'failure' | 'unknown';
  runs: CheckInfo[];
}

export interface MergePreviewRepo {
  connectionId: number;
  kind: ForgeKind;
  host: string;
  repo: string;
  /** The layer of a stack this entry is; 0 otherwise. */
  position: number;
  branch: string;
  target: string;
  targetExists: boolean;
  aheadBy: number;
  behindBy: number;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  conflicts: ConflictState;
  conflictFiles: string[];
  checkedFiles: number;
  uncheckedFiles: number;
  /** Whether the acting account may complete pull requests in this repository. */
  canComplete: 'yes' | 'no' | 'unknown';
  checks: ChecksSummary;
  pullRequest?: {
    ref: string;
    url: string;
    review?: ReviewVote | null;
    /** The pull request's state on the forge. */
    state?: 'open' | 'closed' | 'merged';
    /** Where the forge says the pull request points now. */
    head?: string;
    base?: string;
  };
  error?: string;
}

export interface ReviewSetDiscussion {
  comments: Comment[];
  reviewed: ReviewMark[];
  pullRequests: { connectionId: number; repo: string; position: number; ref: string; url: string }[];
  /** Pull request creation failures, surfaced on the review page. */
  prErrors?: { connectionId: number; repo: string; position: number; message: string }[];
}

export interface RepoCommits {
  connectionId: number;
  repo: string;
  position: number;
  commits: CommitInfo[];
}

export interface RepoChecks {
  connectionId: number;
  repo: string;
  position: number;
  checks: ChecksSummary;
}

export interface MergePreview {
  target: string;
  repos: MergePreviewRepo[];
  canMerge: boolean;
}

/** The repository as it should be shown: Tangled identifiers already start with their host. */
export function repoLabel(repo: { host: string; repo: string }): string {
  return repo.repo.startsWith(`${repo.host}/`) ? repo.repo : `${repo.host}/${repo.repo}`;
}
