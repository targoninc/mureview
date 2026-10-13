import { resolveTxt } from 'node:dns/promises';
import { AtprotoHandleResolver } from '@atproto-labs/handle-resolver';
import type { FileStatus, ForgeKind } from '../../shared/types';
import { Cache, cached } from '../cache';
import { constants } from '../config';
import { patchHeader } from '../patch';
import {
  type BranchInfo,
  type ChecksSummary,
  type CommitInfo,
  type CompareFile,
  type CompareResult,
  type ForgeCallOptions,
  type ForgeClient,
  type ForgeComment,
  type ForgeRepo,
  ForgeError,
  type PostedComment,
  type PullRequestRef,
  type ReviewComment,
  type TreeBlob,
  type TreeListing,
  fetchImage,
} from './types';

const maxFiles = 300;
const maxDirectories = 120;
const pageSize = 100;

// --- atproto identity --------------------------------------------------------

async function resolveHandleTxt(hostname: string): Promise<string[] | null> {
  try {
    const records = await resolveTxt(hostname);
    return records.map((chunks) => chunks.join(''));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'EBADNAME') throw error;
    return null;
  }
}

// The default resolver wraps fetch in the Node SSRF dispatcher, which needs
// process.versions.undici and therefore fails on Bun.
const handleResolver = new AtprotoHandleResolver({ fetch: globalThis.fetch, resolveTxt: resolveHandleTxt });

const didCache = new Cache<string>(500, 6 * 60 * 60_000);
const pdsCache = new Cache<string | null>(500, 24 * 60 * 60_000);

/** Resolves an atproto handle (or passes a DID through). */
export async function tangledDid(handleOrDid: string): Promise<string | null> {
  const value = handleOrDid.trim().replace(/^@/, '');
  if (!value) return null;
  if (value.startsWith('did:')) return value;
  const hit = didCache.get(value);
  if (hit) return hit;
  try {
    const did = await handleResolver.resolve(value);
    if (!did) return null;
    didCache.set(value, did);
    return did;
  } catch {
    return null;
  }
}

/** The PDS (or, for a repository DID, the knot hosting it) of a DID. */
async function pdsFor(did: string): Promise<string | null> {
  const hit = pdsCache.get(did);
  if (hit !== undefined) return hit;
  let endpoint: string | undefined;
  try {
    const url = did.startsWith('did:web:')
      ? `https://${did.slice('did:web:'.length).replace(/:/g, '%3A')}/.well-known/did.json`
      : `https://plc.directory/${did}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.ok) {
      const document = (await response.json()) as { service?: { id?: string; serviceEndpoint?: string }[] };
      endpoint = document.service?.find((service) => service.id === '#atproto_pds')?.serviceEndpoint;
    }
  } catch {
    // no document
  }
  const base = endpoint ? endpoint.replace(/\/+$/, '') : null;
  pdsCache.set(did, base);
  return base;
}

async function getRecord<T>(base: string, repo: string, collection: string, rkey: string): Promise<T | null> {
  const params = new URLSearchParams({ repo, collection, rkey });
  const response = await fetch(`${base}/xrpc/com.atproto.repo.getRecord?${params}`, { headers: { accept: 'application/json' } });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new ForgeError(response.status, await responseMessage(response));
  const body = (await response.json()) as { value?: T };
  return body.value ?? null;
}

async function listRecords<T>(base: string, repo: string, collection: string, maxPages = 10): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ repo, collection, limit: String(pageSize) });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`${base}/xrpc/com.atproto.repo.listRecords?${params}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new ForgeError(response.status, await responseMessage(response));
    const body = (await response.json()) as { records?: T[]; cursor?: string };
    out.push(...(body.records ?? []));
    cursor = body.cursor;
    if (!cursor) break;
  }
  return out;
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/** The avatar of an atproto account, when it has one. */
export async function tangledAvatar(did: string): Promise<string> {
  const pds = await pdsFor(did);
  if (!pds) return '';
  try {
    const record = await getRecord<{ avatar?: { ref?: { $link?: string } } }>(pds, did, 'app.bsky.actor.profile', 'self');
    const cid = record?.avatar?.ref?.$link;
    return cid ? `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg` : '';
  } catch {
    return '';
  }
}

// --- knot XRPC ---------------------------------------------------------------

async function knotGet<T>(base: string, method: string, params: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(`${base}/xrpc/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  // Knots limit unauthenticated requests to a few per second, so back off and
  // retry instead of failing a whole review set.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'mureview' } });
    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 350 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 5000)));
      continue;
    }
    if (!response.ok) throw new ForgeError(response.status, await responseMessage(response));
    try {
      return (await response.json()) as T;
    } catch {
      throw new ForgeError(502, 'the knot returned an unexpected response');
    }
  }
}

interface KnotRefs {
  refs?: { ref: string; sha: string }[];
  cursor?: string;
}

interface KnotBranch {
  name: string;
  hash: string;
}

interface KnotCommit {
  this?: string;
  hash?: number[];
  message?: string;
  parent?: string;
  author?: { Name?: string; Email?: string; When?: string };
  committer?: { Name?: string; Email?: string; When?: string };
}

interface KnotLog {
  commits?: KnotCommit[];
}

interface KnotLine {
  Op: number;
  Line: string;
}

interface KnotFragment {
  OldPosition: number;
  OldLines: number;
  NewPosition: number;
  NewLines: number;
  LinesAdded: number;
  LinesDeleted: number;
  Lines: KnotLine[];
}

interface KnotFile {
  OldName: string;
  NewName: string;
  IsNew: boolean;
  IsDelete: boolean;
  IsCopy: boolean;
  IsRename: boolean;
  IsBinary: boolean;
  TextFragments?: KnotFragment[] | null;
}

interface KnotPatchEntry {
  Files?: KnotFile[] | null;
  SHA: string;
  Title: string;
  Body: string;
  Author?: { Name?: string; Email?: string } | null;
  AuthorDate?: string;
}

interface KnotCompare {
  rev1: string;
  rev2: string;
  merge_base?: string;
  format_patch?: KnotPatchEntry[];
  combined_patch?: KnotFile[] | null;
  patch_raw?: string;
  combined_patch_raw?: string;
  binary_omitted?: boolean;
}

interface KnotTreeEntry {
  name: string;
  mode: string;
  size: number;
}

interface KnotTree {
  files?: KnotTreeEntry[];
}

interface KnotBlob {
  content?: string;
  isBinary?: boolean;
  size?: number;
}

// --- repository resolution ---------------------------------------------------

interface ResolvedRepo {
  ownerDid: string;
  rkey: string;
  repoDid: string | null;
  knot: string;
  repoArg: string;
}

const repoCache = new Cache<ResolvedRepo | null>(200, 10 * 60_000);
const branchListCache = new Cache<BranchInfo[]>(100, 45_000);
const branchCache = new Cache<BranchInfo | null>(300, 45_000);
const compareCache = new Cache<Omit<KnotCompare, 'patch_raw' | 'combined_patch_raw'>>(60, 60 * 60_000);
const treeCache = new Cache<TreeListing>(60, 24 * 60 * 60_000);
const blobCache = new Cache<string>(400, 24 * 60 * 60_000);

export function invalidateTangledBranchCaches(): void {
  branchListCache.clear();
  branchCache.clear();
}

/**
 * A Tangled repository lives on a knot, addressed by its owner's atproto
 * handle (or DID) and its name. Next-generation repositories are declared with
 * an `org.tangled.repo.declaration` record that names the repository's own
 * DID; older ones carry an `sh.tangled.repo` record that names the knot.
 */
async function resolveRepo(repo: string, fresh = false): Promise<ResolvedRepo> {
  const key = repo.trim().replace(/^@/, '');
  const hit = repoCache.get(key);
  if (hit !== undefined && !fresh) {
    if (hit) return hit;
    throw new ForgeError(404, `no Tangled repository named ${key}`);
  }
  const separator = key.indexOf('/');
  const owner = separator > 0 ? key.slice(0, separator) : '';
  const name = separator > 0 ? key.slice(separator + 1) : '';
  if (!owner || !name) throw new ForgeError(400, `"${repo}" is not in owner/name form.`);

  const ownerDid = await tangledDid(owner);
  if (!ownerDid) throw new ForgeError(404, `could not resolve the atproto handle ${owner}`);
  const pds = await pdsFor(ownerDid);
  if (!pds) throw new ForgeError(404, `could not find the PDS of ${owner}`);

  const candidates = name === name.toLowerCase() ? [name] : [name, name.toLowerCase()];
  for (const rkey of candidates) {
    const record = await getRecord<{ repo?: string }>(pds, ownerDid, 'org.tangled.repo.declaration', rkey);
    if (typeof record?.repo === 'string' && record.repo) {
      const knot = await pdsFor(record.repo);
      if (knot) {
        const resolved: ResolvedRepo = { ownerDid, rkey, repoDid: record.repo, knot, repoArg: record.repo };
        repoCache.set(key, resolved);
        return resolved;
      }
    }
  }
  const legacy = await findLegacyRepo(pds, ownerDid, candidates);
  if (legacy) {
    const record = legacy.value;
    const knot = /^https?:\/\//i.test(record.knot!) ? record.knot!.replace(/\/+$/, '') : `https://${record.knot}`;
    const repoDid = typeof record.repoDid === 'string' && record.repoDid ? record.repoDid : null;
    const resolved: ResolvedRepo = { ownerDid, rkey: legacy.rkey, repoDid, knot, repoArg: repoDid ?? `${ownerDid}/${legacy.rkey}` };
    repoCache.set(key, resolved);
    return resolved;
  }

  repoCache.set(key, null);
  throw new ForgeError(404, `no Tangled repository named ${owner}/${name}`);
}

interface LegacyRepoRecord {
  knot?: string;
  repoDid?: string;
  name?: string;
}

/**
 * Legacy `sh.tangled.repo` records are keyed by the repository name, but ones
 * created through the appview carry a TID key with the name in the record.
 */
async function findLegacyRepo(
  pds: string,
  ownerDid: string,
  candidates: string[],
): Promise<{ rkey: string; value: LegacyRepoRecord } | null> {
  for (const rkey of candidates) {
    const record = await getRecord<LegacyRepoRecord>(pds, ownerDid, 'sh.tangled.repo', rkey);
    if (record?.knot) return { rkey, value: record };
  }
  const wanted = candidates.map((candidate) => candidate.toLowerCase());
  const records = await listRecords<{ uri?: string; value?: LegacyRepoRecord }>(pds, ownerDid, 'sh.tangled.repo');
  for (const record of records) {
    const value = record.value;
    if (!value?.knot) continue;
    const name = (value.name ?? '').toLowerCase();
    if (wanted.includes(name)) {
      const rkey = record.uri?.split('/').pop() ?? name;
      return { rkey, value };
    }
  }
  return null;
}

// --- diff building -----------------------------------------------------------

function fileStatus(file: KnotFile): FileStatus {
  if (file.IsNew) return 'added';
  if (file.IsDelete) return 'deleted';
  if (file.IsRename) return 'renamed';
  if (file.IsCopy) return 'copied';
  return 'modified';
}

function filePatch(file: KnotFile, path: string, prevPath: string | undefined, type: FileStatus): string | null {
  if (file.IsBinary) return null;
  const fragments = file.TextFragments ?? [];
  // A mode-only change has no hunks; there is nothing to render.
  if (!fragments.length) return null;
  const header = patchHeader({ path, prevPath, type });
  let body = '';
  for (const fragment of fragments) {
    body += `@@ -${fragment.OldPosition},${fragment.OldLines} +${fragment.NewPosition},${fragment.NewLines} @@\n`;
    for (const line of fragment.Lines) {
      body += `${line.Op === 1 ? '-' : line.Op === 2 ? '+' : ' '}${line.Line}`;
    }
    if (!body.endsWith('\n')) body += '\n';
  }
  return header + body;
}

function toCompareFile(file: KnotFile): CompareFile {
  const path = file.NewName || file.OldName;
  const prevPath = (file.IsRename || file.IsCopy) && file.OldName ? file.OldName : undefined;
  const type = fileStatus(file);
  let additions = 0;
  let deletions = 0;
  for (const fragment of file.TextFragments ?? []) {
    additions += fragment.LinesAdded;
    deletions += fragment.LinesDeleted;
  }
  return { path, prevPath, type, additions, deletions, patch: filePatch(file, path, prevPath, type) };
}

function toCommitInfo(entry: KnotPatchEntry): CommitInfo {
  return {
    sha: entry.SHA,
    message: entry.Title || entry.Body?.split('\n')[0] || '',
    author: entry.Author?.Name || 'unknown',
    date: entry.AuthorDate ?? '',
  };
}

function toLogCommit(commit: KnotCommit): CommitInfo {
  return {
    sha: commit.this ?? '',
    message: (commit.message ?? '').split('\n')[0],
    author: commit.author?.Name || 'unknown',
    date: commit.author?.When ?? '',
  };
}

// --- client ------------------------------------------------------------------

export class TangledClient implements ForgeClient {
  readonly kind: ForgeKind = 'tangled';
  readonly readOnly = true;
  readonly baseUrl: string;
  readonly host: string;

  constructor(baseUrl: string, private login: string) {
    this.baseUrl = (baseUrl || 'https://tangled.org').replace(/\/+$/, '');
    this.host = new URL(this.baseUrl).host;
  }

  async listRepos(): Promise<ForgeRepo[]> {
    const did = await tangledDid(this.login);
    if (!did) throw new ForgeError(400, `could not resolve the atproto handle ${this.login}`);
    const pds = await pdsFor(did);
    if (!pds) throw new ForgeError(404, `could not find the PDS of ${this.login}`);
    const owner = this.login.trim().replace(/^@/, '');
    const names = new Set<string>();
    for (const collection of ['org.tangled.repo.declaration', 'sh.tangled.repo']) {
      const records = await listRecords<{ uri?: string; value?: { name?: string } }>(pds, did, collection);
      for (const record of records) {
        const name = (record.value?.name ?? record.uri?.split('/').pop() ?? '').trim();
        if (name) names.add(name);
      }
    }
    return [...names].sort().map((name) => ({ repo: `${owner}/${name}`, private: false }));
  }

  async ensureRepo(repo: string, options: ForgeCallOptions = {}): Promise<void> {
    await resolveRepo(repo, options.fresh);
  }

  private loadBranches(target: ResolvedRepo): Promise<BranchInfo[]> {
    return (async () => {
      const branches: BranchInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const out = await knotGet<KnotRefs>(target.knot, 'sh.tangled.git.listRefs', { repo: target.repoArg, limit: pageSize, cursor });
        for (const ref of out.refs ?? []) {
          if (ref.ref.startsWith('refs/heads/')) branches.push({ name: ref.ref.slice('refs/heads/'.length), sha: ref.sha });
        }
        cursor = out.cursor;
        if (!cursor) break;
      }
      return branches;
    })();
  }

  async listBranches(repo: string, options: ForgeCallOptions = {}): Promise<BranchInfo[]> {
    const target = await resolveRepo(repo, options.fresh);
    const key = `${target.knot}#${target.repoArg}`;
    if (options.fresh) return this.loadBranches(target);
    return cached(branchListCache, key, () => this.loadBranches(target));
  }

  async getBranch(repo: string, branch: string, options: ForgeCallOptions = {}): Promise<BranchInfo | null> {
    const target = await resolveRepo(repo, options.fresh);
    const key = `${target.knot}#${target.repoArg}#${branch}`;
    const load = async (): Promise<BranchInfo | null> => {
      try {
        const found = await knotGet<KnotBranch>(target.knot, 'sh.tangled.repo.branch', { repo: target.repoArg, name: branch });
        return { name: found.name, sha: found.hash };
      } catch (error) {
        if (error instanceof ForgeError && (error.status === 404 || /not found/i.test(error.message))) return null;
        throw error;
      }
    };
    if (options.fresh) return load();
    const hit = branchCache.get(key);
    if (hit !== undefined) return hit;
    const value = await load();
    branchCache.set(key, value);
    return value;
  }

  private compareOut(repo: string, baseSha: string, headSha: string) {
    return cached(compareCache, `${this.baseUrl}#${repo}:${baseSha}...${headSha}`, async () => {
      const target = await resolveRepo(repo);
      let out: KnotCompare;
      try {
        out = await knotGet<KnotCompare>(target.knot, 'sh.tangled.repo.compare', {
          repo: target.repoArg,
          rev1: baseSha,
          rev2: headSha,
        });
      } catch (error) {
        if (error instanceof ForgeError && /exceeds configured maximum size/i.test(error.message)) {
          throw new ForgeError(413, 'this comparison is too large for the knot to serve');
        }
        throw error;
      }
      const { patch_raw: _patchRaw, combined_patch_raw: _combinedRaw, ...rest } = out;
      return rest;
    });
  }

  async compare(repo: string, baseSha: string, headSha: string): Promise<CompareResult> {
    const out = await this.compareOut(repo, baseSha, headSha);
    const entries = out.format_patch ?? [];
    const merged = out.merge_base === headSha || out.rev1 === out.rev2;
    const rawFiles = out.combined_patch?.length ? out.combined_patch : entries.flatMap((entry) => entry.Files ?? []);
    const files: CompareFile[] = [];
    const seen = new Set<string>();
    for (const file of rawFiles) {
      const path = file.NewName || file.OldName;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      files.push(toCompareFile(file));
    }
    const capped = files.slice(0, maxFiles);
    return {
      merged,
      aheadBy: entries.length,
      behindBy: 0,
      files: capped,
      commits: entries.map(toCommitInfo).reverse(),
      truncated: files.length > capped.length || Boolean(out.binary_omitted) || entries.length >= 500,
    };
  }

  async mergeBase(repo: string, baseSha: string, headSha: string): Promise<string | null> {
    const out = await this.compareOut(repo, baseSha, headSha);
    return out.merge_base ?? null;
  }

  listBlobs(repo: string, sha: string): Promise<TreeListing> {
    return cached(treeCache, `${this.baseUrl}#${repo}#${sha}`, async () => {
      const target = await resolveRepo(repo);
      const blobs: TreeBlob[] = [];
      const queue = [''];
      let truncated = false;
      // Knots serve one directory per request and rate-limit anonymous reads,
      // so keep the walk bounded.
      let directories = 0;
      while (queue.length) {
        const dir = queue.shift()!;
        directories++;
        const tree = await knotGet<KnotTree>(target.knot, 'sh.tangled.repo.tree', {
          repo: target.repoArg,
          ref: sha,
          ...(dir ? { path: dir } : {}),
        });
        for (const entry of tree.files ?? []) {
          const path = dir ? `${dir}/${entry.name}` : entry.name;
          const kind = Number.parseInt(entry.mode, 8) & 0o170000;
          if (kind === 0o040000) {
            if (directories + queue.length < maxDirectories) queue.push(path);
            else truncated = true;
          } else if (kind === 0o160000) {
            // submodules have no contents to read
          } else if (blobs.length < constants.maxRepoFiles) {
            blobs.push({ path, sha: `${sha}:${path}`, size: entry.size });
          } else {
            truncated = true;
          }
        }
      }
      return { blobs, truncated };
    });
  }

  async getBlobText(repo: string, sha: string): Promise<string | null> {
    // listBlobs addresses blobs as `<commit>:<path>` because knots read files
    // by ref and path rather than by object id.
    const separator = sha.indexOf(':');
    if (separator <= 0) return null;
    const ref = sha.slice(0, separator);
    const path = sha.slice(separator + 1);
    const key = `${this.baseUrl}#${repo}#${sha}`;
    const hit = blobCache.get(key);
    if (hit !== undefined) return hit;
    const target = await resolveRepo(repo);
    const blob = await knotGet<KnotBlob>(target.knot, 'sh.tangled.repo.blob', { repo: target.repoArg, ref, path });
    const value = blob.isBinary || typeof blob.content !== 'string' ? null : blob.content;
    if (value !== null) blobCache.set(key, value);
    return value;
  }

  async listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number; pullRequest?: number }): Promise<CommitInfo[]> {
    const limit = options.limit ?? 100;
    if (options.baseSha) {
      const comparison = await this.compare(repo, options.baseSha, options.headSha);
      return comparison.commits.slice(0, limit);
    }
    const target = await resolveRepo(repo);
    const out: CommitInfo[] = [];
    const perPage = Math.min(pageSize, limit);
    let cursor = 0;
    while (out.length < limit) {
      const page = await knotGet<KnotLog>(target.knot, 'sh.tangled.repo.log', {
        repo: target.repoArg,
        ref: options.headSha,
        limit: perPage,
        cursor,
      });
      const commits = page.commits ?? [];
      for (const commit of commits) out.push(toLogCommit(commit));
      if (commits.length < perPage) break;
      cursor += perPage;
    }
    return out.slice(0, limit);
  }

  async checks(): Promise<ChecksSummary> {
    return { state: 'none', runs: [] };
  }

  async fetchAvatar(url: string): Promise<{ contentType: string; body: Buffer } | null> {
    return fetchImage(url, { 'User-Agent': 'mureview' });
  }

  async pullRequestPermission(): Promise<'write' | 'read' | 'unknown'> {
    return 'unknown';
  }

  pullRequestUrl(repo: string, number: number): string {
    return `${this.baseUrl}/${repo}/pulls/${number}`;
  }

  async listComments(): Promise<ForgeComment[]> {
    return [];
  }

  async deleteComment(): Promise<void> {
    // Nothing is mirrored yet, so there is nothing to delete.
  }

  async ensurePullRequest(): Promise<PullRequestRef> {
    throw new ForgeError(501, 'mureview cannot create Tangled pull requests yet');
  }

  async mergePullRequest(): Promise<string> {
    throw new ForgeError(501, 'mureview cannot merge on Tangled yet');
  }

  async createBranch(): Promise<void> {
    throw new ForgeError(501, 'mureview cannot create Tangled branches yet');
  }

  async postReviewComment(_repo: string, _number: number, _comment: ReviewComment): Promise<PostedComment> {
    throw new ForgeError(501, 'mureview cannot post Tangled comments yet');
  }
}
