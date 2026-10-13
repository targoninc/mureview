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
    collect(body, /!(\d+)/g, (match) => ({ id: match[1], type: 'pr' }), refs);
    collect(body, /#(\d+)/g, (match) => ({ id: match[1], type: 'work' }), refs);
  } else {
    collect(body, /#(\d+)/g, (match) => ({ id: match[1], type: 'issue' }), refs);
  }

  return refs.sort((a, b) => a.start - b.start);
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

function collect(
  body: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => Pick<ItemRef, 'id' | 'type'>,
  refs: ItemRef[],
): void {
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    refs.push({ start: match.index, end: match.index + match[0].length, text: match[0], ...build(match) });
  }
}
