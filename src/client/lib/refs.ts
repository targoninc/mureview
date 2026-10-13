import type { RepoStatus } from '../../shared/types';

export interface ItemRef {
  /** Start offset in the body. */
  start: number;
  /** End offset (exclusive). */
  end: number;
  /** The text as written, e.g. "!123". */
  text: string;
  url: string;
  title: string;
}

/**
 * Finds references like "#123" (issue, pull request or work item) and, on
 * Azure DevOps, "!123" (pull request) in a comment, and turns them into links
 * to the forge. The repository context decides which forge and which
 * repository the reference points at.
 */
export function findItemRefs(body: string, repo: RepoStatus | undefined): ItemRef[] {
  if (!repo) return [];
  const refs: ItemRef[] = [];

  if (repo.kind === 'ado') {
    const project = repo.repo.split('/')[0];
    const name = repo.repo.split('/')[1];
    if (!repo.org || !project || !name) return [];
    const base = `https://${repo.host}/${repo.org}/${project}`;
    collect(body, /!(\d+)/g, (match) => ({
      text: match[0],
      url: `${base}/_git/${name}/pullrequest/${match[1]}`,
      title: `Pull request ${match[1]}`,
    }), refs);
    collect(body, /#(\d+)/g, (match) => ({
      text: match[0],
      url: `${base}/_workitems/edit/${match[1]}`,
      title: `Work item ${match[1]}`,
    }), refs);
  } else {
    collect(body, /#(\d+)/g, (match) => ({
      text: match[0],
      url: `https://${repo.host}/${repo.repo}/issues/${match[1]}`,
      title: `Issue or pull request ${match[1]}`,
    }), refs);
  }

  return refs.sort((a, b) => a.start - b.start);
}

function collect(
  body: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => Omit<ItemRef, 'start' | 'end'>,
  refs: ItemRef[],
): void {
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    refs.push({ start: match.index, end: match.index + match[0].length, ...build(match) });
  }
}
