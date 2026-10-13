import { useEffect, useState } from 'react';
import { GitPullRequestIcon, IssueOpenedIcon } from '@primer/octicons-react';
import type { RefInfo, RepoStatus } from '../../../shared/types';
import { api } from '../../lib/api';
import { fallbackRefUrl, findItemRefs, type ItemRef } from '../../lib/refs';

const resolutions = new Map<string, Promise<RefInfo | null>>();

function resolveRef(connectionId: number, repo: string, ref: ItemRef): Promise<RefInfo | null> {
  const key = `${connectionId}#${ref.type}#${repo}#${ref.id}`;
  let promise = resolutions.get(key);
  if (!promise) {
    const query = `connectionId=${connectionId}&repo=${encodeURIComponent(repo)}&type=${ref.type}&id=${ref.id}`;
    promise = api<{ ref: RefInfo | null }>(`/refs?${query}`)
      .then((result) => result.ref)
      .catch(() => null);
    resolutions.set(key, promise);
  }
  return promise;
}

/** A single reference, upgraded from a plain link to a forge-style chip once resolved. */
function RefChip({ connectionId, repo, ref, status }: { connectionId: number; repo: string; ref: ItemRef; status: RepoStatus }) {
  const [info, setInfo] = useState<RefInfo | null>(null);

  useEffect(() => {
    let active = true;
    resolveRef(connectionId, repo, ref).then((result) => {
      if (active) setInfo(result);
    });
    return () => {
      active = false;
    };
  }, [connectionId, repo, ref.type, ref.id]);

  if (!info) {
    const url = fallbackRefUrl(ref, status);
    if (!url) return <>{ref.text}</>;
    return (
      <a className="comment-ref" href={url} target="_blank" rel="noreferrer">
        {ref.text}
      </a>
    );
  }

  const Icon = info.kind === 'pr' ? GitPullRequestIcon : IssueOpenedIcon;
  const label = info.kind === 'pr' ? `PR ${ref.id}` : `#${ref.id}`;
  return (
    <a className="comment-ref-chip" href={info.url} target="_blank" rel="noreferrer" title={info.title || undefined}>
      <Icon size={14} />
      <span className="comment-ref-chip-text">
        {label}
        {info.title ? `: ${info.title}` : ''}
      </span>
    </a>
  );
}

/** A comment body with references like `#123` and `!123` linked to their forge. */
export function CommentBody({
  body,
  repos,
  repo,
}: {
  body: string;
  repos?: RepoStatus[];
  repo: { connectionId: number | null; repo: string | null };
}) {
  const status =
    repos && repo.connectionId !== null && repo.repo
      ? repos.find((entry) => entry.connectionId === repo.connectionId && entry.repo === repo.repo)
      : undefined;
  const refs = findItemRefs(body, status);
  if (!refs.length || !status) return <>{body}</>;

  const parts = [];
  let cursor = 0;
  for (const ref of refs) {
    if (ref.start > cursor) parts.push(body.slice(cursor, ref.start));
    parts.push(<RefChip key={ref.start} connectionId={status.connectionId} repo={status.repo} ref={ref} status={status} />);
    cursor = ref.end;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));

  return <>{parts}</>;
}
