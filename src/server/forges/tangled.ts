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
  withMureviewLink,
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

interface DidDocument {
  /** The PDS — or, for a repository DID, the knot hosting it. */
  pds: string | null;
  /** The account's handle, when the document names one. */
  handle: string | null;
}

const didDocCache = new Cache<DidDocument>(500, 24 * 60 * 60_000);

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

interface DidDocumentJson {
  service?: { id?: string; serviceEndpoint?: string }[];
  alsoKnownAs?: string[];
}

async function didDocument(did: string): Promise<DidDocument> {
  const hit = didDocCache.get(did);
  if (hit) return hit;
  let document: DidDocumentJson | null = null;
  try {
    const url = did.startsWith('did:web:')
      ? `https://${did.slice('did:web:'.length).replace(/:/g, '%3A')}/.well-known/did.json`
      : `https://plc.directory/${did}`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.ok) document = (await response.json()) as DidDocumentJson;
  } catch {
    // no document
  }
  const endpoint = document?.service?.find((service) => service.id === '#atproto_pds')?.serviceEndpoint;
  const handle = (document?.alsoKnownAs ?? [])
    .map((alias) => alias.replace(/^at:\/\//, ''))
    .find((alias) => alias && !alias.startsWith('did:')) ?? null;
  const resolved: DidDocument = { pds: endpoint ? endpoint.replace(/\/+$/, '') : null, handle };
  didDocCache.set(did, resolved);
  return resolved;
}

/** The PDS (or, for a repository DID, the knot hosting it) of a DID. */
async function pdsFor(did: string): Promise<string | null> {
  return (await didDocument(did)).pds;
}

/** The handle of an atproto account, when its DID document names one. */
async function handleFor(did: string): Promise<string> {
  if (!did) return 'unknown';
  return (await didDocument(did)).handle ?? did;
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

const avatarCache = new Cache<string>(300, 6 * 60 * 60_000);

/** The avatar of an atproto account, when it has one. */
export async function tangledAvatar(did: string): Promise<string> {
  if (!did) return '';
  const hit = avatarCache.get(did);
  if (hit !== undefined) return hit;
  let avatarUrl = '';
  const pds = await pdsFor(did);
  if (pds) {
    try {
      const record = await getRecord<{ avatar?: { ref?: { $link?: string } } }>(pds, did, 'app.bsky.actor.profile', 'self');
      const cid = record?.avatar?.ref?.$link;
      if (cid) avatarUrl = `https://cdn.bsky.app/img/avatar/plain/${did}/${cid}@jpeg`;
    } catch {
      // no profile record
    }
  }
  avatarCache.set(did, avatarUrl);
  return avatarUrl;
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

function toCommitInfo(entry: KnotPatchEntry, url: (sha: string) => string): CommitInfo {
  return {
    sha: entry.SHA,
    message: entry.Title || entry.Body?.split('\n')[0] || '',
    author: entry.Author?.Name || 'unknown',
    date: entry.AuthorDate ?? '',
    url: url(entry.SHA),
  };
}

function toLogCommit(commit: KnotCommit, url: (sha: string) => string): CommitInfo {
  const sha = commit.this ?? '';
  return {
    sha,
    message: (commit.message ?? '').split('\n')[0],
    author: commit.author?.Name || 'unknown',
    date: commit.author?.When ?? '',
    url: sha ? url(sha) : undefined,
  };
}

// --- client ------------------------------------------------------------------

export interface TangledWriteAuth {
  /** The atproto account whose session mints service-auth tokens. */
  did: string;
  /** Mints a service-auth JWT for a knot call (aud is the repository DID). */
  serviceAuth: (options: { aud: string; lxm: string }) => Promise<string>;
}

interface KnotWrittenRecord {
  uri?: string;
  cid?: string;
}

interface KnotPatchRecord {
  ticket?: string;
  createdAt?: string;
}

interface KnotCommentRecord {
  subject?: { uri?: string; cid?: string };
  replyTo?: { uri?: string; cid?: string };
  body?: { text?: string };
  createdAt?: string;
  'x-tngl-editor'?: string;
}

export class TangledClient implements ForgeClient {
  readonly kind: ForgeKind = 'tangled';
  readonly baseUrl: string;
  readonly host: string;

  constructor(baseUrl: string, private login: string, private writes?: TangledWriteAuth) {
    this.baseUrl = (baseUrl || 'https://tangled.org').replace(/\/+$/, '');
    this.host = new URL(this.baseUrl).host;
  }

  private commitUrl(repo: string, sha: string): string {
    return `${this.baseUrl}/${repo}/commit/${sha}`;
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
      commits: entries.map((entry) => toCommitInfo(entry, (sha) => this.commitUrl(repo, sha))).reverse(),
      truncated: files.length > capped.length || Boolean(out.binary_omitted) || entries.length >= 500,
      mergeBase: out.merge_base,
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

  async listCommits(repo: string, options: { headSha: string; baseSha?: string; limit?: number; pullRequest?: string }): Promise<CommitInfo[]> {
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
      for (const commit of commits) out.push(toLogCommit(commit, (sha) => this.commitUrl(repo, sha)));
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

  pullRequestUrl(repo: string, ref: string): string {
    return `${this.baseUrl}/${repo}/pulls/${ref}`;
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Calls a knot method with a service-auth token minted through the
   * connected account's PDS. Knots verify the token's audience against the
   * repository's DID and the method against the JWT's lxm claim.
   */
  private async authorizedPost<T>(knot: string, method: string, body: unknown, repoDid: string): Promise<T> {
    if (!this.writes) {
      throw new ForgeError(401, `sign in with atproto as ${this.login} under Settings to write on Tangled`);
    }
    let token: string;
    try {
      token = await this.writes.serviceAuth({ aud: repoDid, lxm: method });
    } catch (error) {
      const detail = (error as Error).message;
      throw new ForgeError(
        401,
        /no atproto session/i.test(detail)
          ? `sign in with atproto as ${this.login} under Settings, then reload this review set`
          : `could not mint a service token for this knot (${detail})`,
      );
    }
    const response = await fetch(`${knot}/xrpc/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': 'mureview',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const message = await responseMessage(response);
      if (response.status === 401 || response.status === 403) {
        throw new ForgeError(
          response.status,
          `the knot rejected this write (${message}) — check that ${this.login} is a member of ${new URL(knot).host} with push access`,
        );
      }
      throw new ForgeError(response.status, message);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new ForgeError(502, 'the knot returned an unexpected response');
    }
  }

  private async hosted(repo: string): Promise<ResolvedRepo & { repoDid: string }> {
    const target = await resolveRepo(repo);
    if (!target.repoDid) {
      throw new ForgeError(400, 'this repository predates repository DIDs, so mureview cannot write to it');
    }
    return { ...target, repoDid: target.repoDid };
  }

  private ticketUri(repoDid: string, ref: string): string {
    return `at://${repoDid}/org.tangled.track.ticket/${ref}`;
  }

  /** The patches of a ticket, newest first. */
  private async ticketPatches(knot: string, repoDid: string, ref: string): Promise<{ rkey: string; record: KnotPatchRecord }[]> {
    const records = await listRecords<{ uri?: string; value?: KnotPatchRecord }>(knot, repoDid, 'org.tangled.review.patch');
    return records
      .filter((record) => record.value?.ticket === ref)
      .map((record) => ({ rkey: record.uri?.split('/').pop() ?? '', record: record.value ?? {} }))
      .filter((entry) => entry.rkey)
      .sort((a, b) => (b.record.createdAt ?? '').localeCompare(a.record.createdAt ?? ''));
  }

  /**
   * A Tangled pull request is a ticket (the discussion) plus a patch (the
   * commit range); the knot replays the patch onto the target branch when it
   * is merged.
   */
  async ensurePullRequest(
    repo: string,
    base: string,
    head: string,
    title: string,
    body = '',
    mureviewUrl?: string,
  ): Promise<PullRequestRef> {
    const target = await this.hosted(repo);
    const [baseRef, headRef] = await Promise.all([this.getBranch(repo, base, { fresh: true }), this.getBranch(repo, head, { fresh: true })]);
    if (!baseRef) throw new ForgeError(404, `the target branch ${base} does not exist`);
    if (!headRef) throw new ForgeError(404, `the branch ${head} does not exist`);
    // The patch's range should start at the merge base so the pull request
    // shows only this branch's changes; a comparison that is too large for the
    // knot falls back to the target tip.
    const mergeBase = (await this.mergeBase(repo, baseRef.sha, headRef.sha).catch(() => null)) ?? baseRef.sha;
    const description = withMureviewLink(body, mureviewUrl);
    const createdAt = new Date().toISOString();

    const ticket = await this.authorizedPost<KnotWrittenRecord>(
      target.knot,
      'com.atproto.repo.createRecord',
      {
        repo: target.repoDid,
        collection: 'org.tangled.track.ticket',
        record: {
          $type: 'org.tangled.track.ticket',
          title: { text: title },
          ...(description ? { body: { $type: 'org.tangled.markup.markdown', text: description } } : {}),
          state: 'open',
          targetBranch: base,
          createdAt,
        },
      },
      target.repoDid,
    );
    const ticketRkey = ticket.uri?.split('/').pop();
    if (!ticketRkey) throw new ForgeError(502, 'the knot did not return the new pull request');

    await this.authorizedPost(
      target.knot,
      'com.atproto.repo.createRecord',
      {
        repo: target.repoDid,
        collection: 'org.tangled.review.patch',
        record: {
          $type: 'org.tangled.review.patch',
          ticket: ticketRkey,
          base: { oid: mergeBase },
          head: { oid: headRef.sha },
          createdAt,
        },
      },
      target.repoDid,
    );
    return { ref: ticketRkey, created: true };
  }

  async mergePullRequest(repo: string, ref: string, _message: string): Promise<string> {
    const target = await this.hosted(repo);
    const patches = await this.ticketPatches(target.knot, target.repoDid, ref);
    const latest = patches[0];
    if (!latest) throw new ForgeError(404, 'this pull request has no patch to merge');
    await this.authorizedPost(
      target.knot,
      'sh.tangled.repo.pull.merge',
      { repo: target.repoDid, rkey: latest.rkey },
      target.repoDid,
    );
    return `merged pull request ${ref}`;
  }

  /** Rewrites the ticket's targetBranch so the patch lands on another branch. */
  async retargetPullRequest(repo: string, ref: string, base: string): Promise<void> {
    const target = await this.hosted(repo);
    let current: { cid?: string; value?: Record<string, unknown> } | null = null;
    try {
      current = await knotGet<{ cid?: string; value?: Record<string, unknown> }>(target.knot, 'com.atproto.repo.getRecord', {
        repo: target.repoDid,
        collection: 'org.tangled.track.ticket',
        rkey: ref,
      });
    } catch (error) {
      if (error instanceof ForgeError && error.status === 400) throw new ForgeError(404, 'the pull request this layer belongs to is gone');
      throw error;
    }
    if (!current?.value) throw new ForgeError(404, 'the pull request this layer belongs to is gone');
    await this.authorizedPost(
      target.knot,
      'com.atproto.repo.putRecord',
      {
        repo: target.repoDid,
        collection: 'org.tangled.track.ticket',
        rkey: ref,
        record: { ...current.value, targetBranch: base },
        ...(current.cid ? { swapRecord: current.cid } : {}),
      },
      target.repoDid,
    );
  }

  async createBranch(): Promise<void> {
    throw new ForgeError(501, 'mureview cannot create Tangled branches yet');
  }

  async postReviewComment(repo: string, ref: string, comment: ReviewComment): Promise<PostedComment> {
    const target = await this.hosted(repo);
    const subject = await recordRef(target.knot, target.repoDid, 'org.tangled.track.ticket', ref);
    if (!subject) throw new ForgeError(404, 'the pull request this comment belongs to is gone');

    let replyTo: { uri: string; cid: string } | undefined;
    if (comment.replyTo) {
      const parent = await recordRef(target.knot, target.repoDid, 'org.tangled.feed.comment', comment.replyTo);
      if (parent) replyTo = parent;
    }

    // Tangled comments are not anchored to lines; keep the location readable
    // in the body so it is not lost.
    const text = comment.path ? `${comment.path}:${comment.line}\n\n${comment.body}` : comment.body;
    const created = await this.authorizedPost<KnotWrittenRecord>(
      target.knot,
      'com.atproto.repo.createRecord',
      {
        repo: target.repoDid,
        collection: 'org.tangled.feed.comment',
        record: {
          $type: 'org.tangled.feed.comment',
          subject,
          ...(replyTo ? { replyTo } : {}),
          body: { $type: 'org.tangled.markup.markdown', text },
          createdAt: new Date().toISOString(),
        },
      },
      target.repoDid,
    );
    const rkey = created.uri?.split('/').pop();
    return { kind: 'pull-request', id: rkey };
  }

  async deleteComment(repo: string, _ref: string, commentId: string): Promise<void> {
    const target = await this.hosted(repo);
    try {
      await this.authorizedPost(
        target.knot,
        'com.atproto.repo.deleteRecord',
        { repo: target.repoDid, collection: 'org.tangled.feed.comment', rkey: commentId },
        target.repoDid,
      );
    } catch (error) {
      if (error instanceof ForgeError && error.status === 404) return;
      throw error;
    }
  }

  async listComments(repo: string, ref: string): Promise<ForgeComment[]> {
    const target = await this.hosted(repo);
    const subjectUris = new Set([this.ticketUri(target.repoDid, ref)]);
    for (const patch of await this.ticketPatches(target.knot, target.repoDid, ref)) {
      subjectUris.add(`at://${target.repoDid}/org.tangled.review.patch/${patch.rkey}`);
    }
    const records = await listRecords<{ uri?: string; value?: KnotCommentRecord }>(target.knot, target.repoDid, 'org.tangled.feed.comment');
    const comments: ForgeComment[] = [];
    for (const record of records) {
      const value = record.value;
      const subject = value?.subject?.uri;
      if (!value || !subject || !subjectUris.has(subject)) continue;
      const editor = value['x-tngl-editor'] ?? '';
      comments.push({
        id: record.uri?.split('/').pop() ?? '',
        author: { name: await handleFor(editor), avatarUrl: editor ? await tangledAvatar(editor) : '' },
        body: value.body?.text ?? '',
        createdAt: value.createdAt ?? '',
      });
    }
    return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/** A strongRef to a record: the knot needs both its URI and its CID. */
async function recordRef(knot: string, repoDid: string, collection: string, rkey: string): Promise<{ uri: string; cid: string } | null> {
  const params = new URLSearchParams({ repo: repoDid, collection, rkey });
  const response = await fetch(`${knot}/xrpc/com.atproto.repo.getRecord?${params}`, { headers: { accept: 'application/json' } });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new ForgeError(response.status, await responseMessage(response));
  const body = (await response.json()) as { uri?: string; cid?: string };
  return body.uri && body.cid ? { uri: body.uri, cid: body.cid } : null;
}
