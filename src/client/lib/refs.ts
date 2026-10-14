import type { RepoStatus } from '../../shared/types';

export interface ItemRef {
  /** Start offset in the body. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The text as written, e.g. "!123". */
  text: string;
  id: string;
  type: 'pr' | 'issue' | 'work';
}

/**
 * Finds references like "#123" (issue, pull request or work item) and, on
 * Azure DevOps, "!123" (pull request) in a comment. The repository context
 * decides which forge the reference belongs to.
 */
export function findItemRefs(body: string, repo: RepoStatus | undefined): ItemRef[] {
  if (!repo) return [];
  const refs: ItemRef[] = [];

  if (repo.kind === 'ado') {
    collect<ItemRef>(body, /!(\d+)/g, (match) => ({ id: match[1], type: 'pr' }), refs);
    collect<ItemRef>(body, /#(\d+)/g, (match) => ({ id: match[1], type: 'work' }), refs);
  } else {
    collect<ItemRef>(body, /#(\d+)/g, (match) => ({ id: match[1], type: 'issue' }), refs);
  }

  return refs.sort((a, b) => a.start - b.start);
}

export interface MentionRef {
  /** Start offset in the body. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The text as written, e.g. "@<8c8c8c8c-…>". */
  text: string;
  id: string;
}

/**
 * Azure DevOps writes mentions as `@<identity-id>`; the id names the account.
 * Other forges write plain `@handle` text, which needs no resolution.
 */
export function findMentions(body: string, repo: RepoStatus | undefined): MentionRef[] {
  if (!repo || repo.kind !== 'ado') return [];
  const mentions: MentionRef[] = [];
  collect<MentionRef>(body, /@<([0-9a-fA-F-]{36})>/g, (match) => ({ id: match[1] }), mentions);
  return mentions;
}

/** Whether an offset sits inside an inline code span (odd backticks before it). */
function inCodeSpan(body: string, index: number): boolean {
  let backticks = 0;
  for (let cursor = 0; cursor < index; cursor++) {
    if (body[cursor] === '`') backticks++;
  }
  return backticks % 2 === 1;
}

/**
 * Where a reference points when the forge cannot resolve it. Azure DevOps
 * pull request ids are organization-wide, so this is only a guess until the
 * lookup confirms the repository.
 */
export function fallbackRefUrl(ref: ItemRef, repo: RepoStatus): string | null {
  if (repo.kind !== 'ado') return `https://${repo.host}/${repo.repo}/issues/${ref.id}`;
  const [project, name] = repo.repo.split('/');
  if (!repo.org || !project || !name) return null;
  const base = `https://${repo.host}/${repo.org}/${project}`;
  return ref.type === 'pr' ? `${base}/_git/${name}/pullrequest/${ref.id}` : `${base}/_workitems/edit/${ref.id}`;
}

function collect<T extends { start: number; end: number; text: string }>(
  body: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => Omit<T, 'start' | 'end' | 'text'>,
  refs: T[],
): void {
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    // A reference inside `code` stays literal.
    if (inCodeSpan(body, match.index)) continue;
    refs.push({ start: match.index, end: match.index + match[0].length, text: match[0], ...build(match) } as T);
  }
}
