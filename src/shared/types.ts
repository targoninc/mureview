export type ForgeKind = 'github' | 'forgejo' | 'ado' | 'tangled';

export type AuthProvider = 'github' | 'forgejo' | 'atproto' | 'email' | 'entra';

export interface User {
  id: number;
  name: string;
  avatarUrl: string;
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
}

export interface MeResponse {
  user: User | null;
  identities: IdentityInfo[];
  connections: ForgeConnectionInfo[];
  providers: AuthProvider[];
  githubOAuthAppUrl: string | null;
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

export type ReviewSetMode = 'pattern' | 'per-repo';

export interface ReviewSetRepo {
  connectionId: number;
  repo: string;
  kind: ForgeKind;
  host: string;
  org: string | null;
  /** Selected source branch in per-repo mode. */
  branch: string | null;
  /** Selected target branch in per-repo mode. */
  target: string | null;
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
  repos: { connectionId: number; repo: string; branch?: string | null; target?: string | null }[];
  mode: ReviewSetMode;
  branchRegex: string;
  targetBranch: string;
}

export interface RepoSource {
  connectionId: number;
  kind: ForgeKind;
  host: string;
  org: string | null;
  login: string;
  label: string;
}

export interface AvailableRepo {
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
  targetExists: boolean;
  state: RepoPrState;
  aheadBy?: number;
  behindBy?: number;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  headSha?: string;
  pullRequest?: { ref: string; url: string };
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
  path: string;
}

export interface PrStatus {
  state: PrLifecycle;
  errors: string[];
  repos: RepoStatus[];
  prId: number | null;
  comments: Comment[];
  reviewed: ReviewMark[];
  stats: { repos: number; files: number; additions: number; deletions: number };
}

export interface ReviewSetDetail {
  reviewSet: ReviewSet;
  pr: PrStatus;
  /** False when the review set belongs to another user and is only readable. */
  owned: boolean;
  owner: { name: string; avatarUrl: string } | null;
}

export interface MergeResult {
  connectionId: number;
  label: string;
  ok: boolean;
  message: string;
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
  pullRequest?: { ref: string; url: string };
  error?: string;
}

export interface ReviewSetDiscussion {
  comments: Comment[];
  reviewed: ReviewMark[];
  pullRequests: { connectionId: number; repo: string; ref: string; url: string }[];
}

export interface RepoCommits {
  connectionId: number;
  repo: string;
  commits: CommitInfo[];
}

export interface RepoChecks {
  connectionId: number;
  repo: string;
  checks: ChecksSummary;
}

export interface MergePreview {
  target: string;
  repos: MergePreviewRepo[];
  canMerge: boolean;
}
