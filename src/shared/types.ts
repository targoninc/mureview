export type ForgeKind = 'github' | 'forgejo';

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
  login: string;
  avatarUrl: string;
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

export interface AvailableRepo {
  connectionId: number;
  repo: string;
  kind: ForgeKind;
  host: string;
  login: string;
  private: boolean;
}

export interface RepoSearchResponse {
  repos: AvailableRepo[];
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
  createdAt: string;
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
