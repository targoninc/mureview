import { BranchName } from '@primer/react';
import type { RepoStatus } from '../../../shared/types';
import { timeAgo } from '../../lib/format';

function CommitRow({ commit }: { commit: NonNullable<RepoStatus['commits']>[number] }) {
  const content = (
    <>
      <span className="mono commit-sha">{commit.sha.slice(0, 7)}</span>
      <span className="commit-message" title={commit.message}>
        {commit.message}
      </span>
      <span className="commit-meta">
        {commit.author}
        {commit.date ? ` · ${timeAgo(commit.date)}` : ''}
      </span>
    </>
  );
  return commit.url ? (
    <a className="commit-row" href={commit.url} target="_blank" rel="noreferrer">
      {content}
    </a>
  ) : (
    <div className="commit-row">{content}</div>
  );
}

export function CommitList({ repos, target }: { repos: RepoStatus[]; target: string }) {
  const withCommits = repos.filter((repo) => repo.commits && repo.commits.length > 0);
  if (!withCommits.length) return <div className="empty-state">No commits to show.</div>;

  return (
    <div className="stack" style={{ gap: 18, padding: 12 }}>
      {withCommits.map((repo) => (
        <div className="stack" key={`${repo.connectionId}:${repo.repo}`} style={{ gap: 6 }}>
          <span className="row" style={{ gap: 6, fontSize: 12, color: 'var(--fgColor-muted)' }}>
            <span className="mono">
              {repo.host}/{repo.repo}
            </span>
            {repo.branch ? <BranchName>{repo.branch}</BranchName> : null}
            <span aria-hidden="true">→</span>
            <BranchName>{repo.target || target}</BranchName>
            <span>
              ({repo.commitsTruncated ? `showing ${repo.commits!.length} of ${repo.aheadBy}` : repo.commits!.length})
            </span>
          </span>
          {repo.commits!.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))}
        </div>
      ))}
    </div>
  );
}
