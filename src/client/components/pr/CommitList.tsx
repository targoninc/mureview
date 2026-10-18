import { BranchName } from '@primer/react';
import type { RepoStatus } from '../../../shared/types';
import { timeAgo } from '../../lib/format';
import { ServiceIcon, serviceDetail } from '../ServiceIcon';

function CommitRow({ commit }: { commit: NonNullable<RepoStatus['commits']>[number] }) {
  const content = (
    <>
      <span className="commit-message" title={commit.message}>
        {commit.message}
      </span>
      <span className="commit-meta">
        <span className="mono commit-sha">{commit.sha.slice(0, 7)}</span>
        <span>
          {commit.author}
          {commit.date ? ` · ${timeAgo(commit.date)}` : ''}
        </span>
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
    <div className="stack" style={{ gap: 14, padding: 12 }}>
      {withCommits.map((repo) => (
        <section className="commit-group" key={`${repo.connectionId}:${repo.repo}`}>
          <div className="commit-group-head">
            <span className="row commit-repo" style={{ gap: 6 }}>
              <ServiceIcon kind={repo.kind} detail={serviceDetail(repo.kind, repo)} />
              <span className="mono">
                {repo.host}/{repo.repo}
              </span>
            </span>
            <span className="row commit-branches" style={{ gap: 6 }}>
              {repo.branch ? <BranchName>{repo.branch}</BranchName> : null}
              <span aria-hidden="true">→</span>
              <BranchName>{repo.target || target}</BranchName>
              <span className="commit-count">
                {repo.commitsTruncated
                  ? `showing ${repo.commits!.length} of ${repo.aheadBy}`
                  : `${repo.commits!.length} ${repo.commits!.length === 1 ? 'commit' : 'commits'}`}
              </span>
            </span>
          </div>
          {repo.commits!.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))}
        </section>
      ))}
    </div>
  );
}
