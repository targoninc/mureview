export type ForgeKind = 'github' | 'forgejo' | 'ado';

export type AuthProvider = 'github' | 'forgejo' | 'atproto' | 'email';

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

export interface ReviewSetRepo {
  connectionId: number;
  repo: string;
  kind: ForgeKind;
  host: string;
  org: string | null;
}

export interface ReviewSet {
  id: number;
  name: string;
  repos: ReviewSetRepo[];
  branchRegex: string;
  targetBranch: string;
  createdAt: string;
}

export interface ReviewSetInput {
  name: string;
  repos: { connectionId: number; repo: string }[];
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
  targetExists: boolean;
  state: RepoPrState;
  aheadBy?: number;
  behindBy?: number;
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  headSha?: string;
  pullRequest?: { number: number; url: string };
  commits?: CommitInfo[];
  commitsTruncated?: boolean;
  files?: FileDiff[];
}

export type PrLifecycle = 'invalid' | 'empty' | 'open' | 'closed';

export interface Comment {
  id: number;
  prId: number;
  author: { name: string; avatarUrl: string };
  connectionId: number | null;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  body: string;
  synced: boolean;
  source: 'mureview' | 'forge';
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
  checks: ChecksSummary;
  pullRequest?: { number: number; url: string };
  error?: string;
}

export interface ReviewSetDiscussion {
  comments: Comment[];
  reviewed: ReviewMark[];
  pullRequests: { connectionId: number; repo: string; number: number; url: string }[];
}

export interface RepoCommits {
  connectionId: number;
  repo: string;
  commits: CommitInfo[];
}

export interface MergePreview {
  target: string;
  repos: MergePreviewRepo[];
  canMerge: boolean;
}
