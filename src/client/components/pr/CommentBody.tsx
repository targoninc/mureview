import type { RepoStatus } from '../../../shared/types';
import { findItemRefs } from '../../lib/refs';

/** A comment body with references like `#123` and `!123` linked to their forge. */
export function CommentBody({ body, repos, repo }: { body: string; repos?: RepoStatus[]; repo: { connectionId: number | null; repo: string | null } }) {
  const status =
    repos && repo.connectionId !== null && repo.repo
      ? repos.find((entry) => entry.connectionId === repo.connectionId && entry.repo === repo.repo)
      : undefined;
  const refs = findItemRefs(body, status);
  if (!refs.length) return <>{body}</>;

  const parts = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) parts.push(body.slice(cursor, ref.start));
    parts.push(
      <a key={ref.start} className="comment-ref" href={ref.url} target="_blank" rel="noreferrer" title={ref.title}>
        {ref.text}
      </a>,
    );
    cursor = ref.end;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));

  return <>{parts}</>;
}
