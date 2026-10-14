import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar, Button, Flash, Heading, Label, Spinner } from '@primer/react';
import { GitBranchIcon, PlusIcon, RepoIcon } from '@primer/octicons-react';
import type { ReviewSet } from '../../shared/types';
import { repoLabel } from '../../shared/types';
import { api } from '../lib/api';

function ReviewSetItem({ reviewSet }: { reviewSet: ReviewSet }) {
  // Stacks hold several entries per repository; count the repositories.
  const repos = [...new Map(reviewSet.repos.map((repo) => [`${repo.connectionId}:${repo.repo}`, repo])).values()];
  const layers = reviewSet.mode === 'stack' ? reviewSet.repos.length : 0;
  const branches = reviewSet.repos.filter((repo) => repo.branch);
  const perRepoTargets = new Set(branches.map((repo) => repo.target ?? reviewSet.targetBranch));
  const sharedTarget = perRepoTargets.size === 1 ? [...perRepoTargets][0] : null;
  // Each mode selects branches differently; show what actually happens.
  const branchPairs = branches
    .map((repo) => `${repoLabel(repo)}: ${repo.branch} → ${repo.target ?? reviewSet.targetBranch}`)
    .join('\n');
  const summary =
    reviewSet.mode === 'pattern' ? (
      <>
        <Label variant="secondary">/{reviewSet.branchRegex}/</Label>
        <span className="row">
          <GitBranchIcon size={14} /> target: <span className="mono">{reviewSet.targetBranch}</span>
        </span>
      </>
    ) : reviewSet.mode === 'stack' ? (
      <>
        <Label variant="accent">stacked</Label>
        <span className="row" title={branchPairs}>
          <GitBranchIcon size={14} />
          {layers} {layers === 1 ? 'layer' : 'layers'} in {repos.length} {repos.length === 1 ? 'stack' : 'stacks'} →{' '}
          <span className="mono">{reviewSet.targetBranch}</span>
        </span>
      </>
    ) : (
      <>
        <Label variant="secondary">per-repo</Label>
        <span className="row" title={branchPairs}>
          <GitBranchIcon size={14} />
          {branches.length === 1 ? (
            <>
              <span className="mono">{branches[0].branch}</span> →{' '}
              <span className="mono">{branches[0].target ?? reviewSet.targetBranch}</span>
            </>
          ) : sharedTarget !== null ? (
            <>
              {branches.length} branches → <span className="mono">{sharedTarget}</span>
            </>
          ) : (
            <>{branches.length} branches → their own targets</>
          )}
        </span>
      </>
    );
  return (
    <Link className="repo-list-item" to={`/review-sets/${reviewSet.id}`}>
      <div className="repo-list-main">
        <Heading as="h2" variant="small">
          {reviewSet.name}
        </Heading>
        <div className="repo-list-meta">
          {reviewSet.owner ? (
            <span className="row">
              <Avatar src={reviewSet.owner.avatarUrl} size={16} alt={reviewSet.owner.name} /> {reviewSet.owner.name}
            </span>
          ) : null}
          {summary}
        </div>
      </div>
      <span className="repo-list-count" title={repos.map((repo) => repoLabel(repo)).join('\n')}>
        <RepoIcon size={14} />
        {repos.length} {repos.length === 1 ? 'repo' : 'repos'}
        {layers > 0 ? ` · ${layers} ${layers === 1 ? 'layer' : 'layers'}` : ''} included
      </span>
    </Link>
  );
}

export function Dashboard() {
  const [reviewSets, setReviewSets] = useState<ReviewSet[] | null>(null);
  const [sharedSets, setSharedSets] = useState<ReviewSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<{ reviewSets: ReviewSet[]; sharedReviewSets?: ReviewSet[] }>('/review-sets')
      .then((result) => {
        setReviewSets(result.reviewSets);
        setSharedSets(result.sharedReviewSets ?? []);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="page-title-row">
          <Heading as="h1" variant="medium">
            Review sets
          </Heading>
          <Button variant="primary" leadingVisual={PlusIcon} onClick={() => navigate('/review-sets/new')}>
            New review set
          </Button>
        </div>

        {error ? <Flash variant="danger">{error}</Flash> : null}
        {!reviewSets && !error ? <Spinner aria-label="Loading review sets" /> : null}

        {reviewSets && reviewSets.length === 0 ? (
          <div className="empty-state">No review sets yet. Create one to watch a branch across repositories.</div>
        ) : null}

        {reviewSets && reviewSets.length > 0 ? (
          <div className="repo-list">
            {reviewSets.map((reviewSet) => (
              <ReviewSetItem key={reviewSet.id} reviewSet={reviewSet} />
            ))}
          </div>
        ) : null}

        {sharedSets && sharedSets.length > 0 ? (
          <>
            <Heading as="h2" variant="small" className="section-heading">
              Review sets from others
            </Heading>
            <div className="repo-list">
              {sharedSets.map((reviewSet) => (
                <ReviewSetItem key={reviewSet.id} reviewSet={reviewSet} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
