import type { CheckInfo, ChecksSummary, FileStatus, ForgeKind } from '../../shared/types';

export type { CheckInfo, ChecksSummary };

export class ForgeError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ForgeRepo {
  repo: string;
  private: boolean;
  updatedAt?: string;
}

export interface BranchInfo {
  name: string;
  sha: string;
}

export interface CompareFile {
  path: string;
  prevPath?: string;
  type: FileStatus;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface CompareResult {
  merged: boolean;
  aheadBy: number;
  behindBy: number;
  files: CompareFile[];
  truncated: boolean;
}

export interface TreeBlob {
  path: string;
  sha: string;
  size: number;
}

export interface TreeListing {
  blobs: TreeBlob[];
  truncated: boolean;
}

export interface ForgeCallOptions {
  fresh?: boolean;
}

export interface PullRequestRef {
  number: number;
  created: boolean;
}

export interface ReviewComment {
  body: string;
  path: string;
  line: number;
  side: 'additions' | 'deletions';
  commitId?: string;
}

export interface ForgeClient {
  readonly kind: ForgeKind;
  readonly baseUrl: string;
  readonly host: string;
  listRepos(): Promise<ForgeRepo[]>;
  ensureRepo(repo: string, options?: ForgeCallOptions): Promise<void>;
  listBranches(repo: string, options?: ForgeCallOptions): Promise<BranchInfo[]>;
  getBranch(repo: string, branch: string, options?: ForgeCallOptions): Promise<BranchInfo | null>;
  compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult>;
  mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null>;
  listBlobs(repo: string, sha: string): Promise<TreeListing>;
  getBlobText(repo: string, sha: string): Promise<string | null>;
  ensurePullRequest(repo: string, base: string, head: string, title: string, body?: string): Promise<PullRequestRef>;
  mergePullRequest(repo: string, number: number, message: string): Promise<string>;
  pullRequestUrl(repo: string, number: number): string;
  postReviewComment(repo: string, number: number, comment: ReviewComment): Promise<'line' | 'pull-request'>;
  checks(repo: string, sha: string): Promise<ChecksSummary>;
  createBranch(repo: string, target: string, from: { sha: string; branch: string }): Promise<void>;
}

export function hostOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

export const statusMap: Record<string, FileStatus> = {
  added: 'added',
  removed: 'deleted',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};

export function decodeText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

export function summarizeChecks(runs: CheckInfo[]): ChecksSummary['state'] {
  if (!runs.length) return 'none';
  if (runs.some((run) => run.state === 'failure')) return 'failure';
  if (runs.some((run) => run.state === 'pending' || run.state === 'unknown')) return 'pending';
  return 'success';
}
