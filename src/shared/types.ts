export interface User {
  id: number;
  login: string;
  name: string;
  avatarUrl: string;
}

export interface ReviewSet {
  id: number;
  name: string;
  repos: string[];
  branchRegex: string;
  targetBranch: string;
  createdAt: string;
}

export interface ReviewSetInput {
  name: string;
  repos: string[];
  branchRegex: string;
  targetBranch: string;
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
  author: { login: string; avatarUrl: string };
  repo: string | null;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  body: string;
  createdAt: string;
}

export interface CommentInput {
  repo: string | null;
  path: string | null;
  line: number | null;
  side: 'additions' | 'deletions' | null;
  body: string;
}

export interface PrStatus {
  state: PrLifecycle;
  errors: string[];
  repos: RepoStatus[];
  prId: number | null;
  comments: Comment[];
  stats: { repos: number; files: number; additions: number; deletions: number };
}

export interface ReviewSetDetail {
  reviewSet: ReviewSet;
  pr: PrStatus;
}

export interface MergeResult {
  repo: string;
  ok: boolean;
  message: string;
}
