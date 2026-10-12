import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Flash, Heading, Label, Spinner } from '@primer/react';
import { GitBranchIcon, PlusIcon, RepoIcon } from '@primer/octicons-react';
import type { ReviewSet } from '../../shared/types';
import { api } from '../lib/api';

export function Dashboard() {
  const [reviewSets, setReviewSets] = useState<ReviewSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api<{ reviewSets: ReviewSet[] }>('/review-sets')
      .then((result) => setReviewSets(result.reviewSets))
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
              <Link key={reviewSet.id} className="repo-list-item" to={`/review-sets/${reviewSet.id}`}>
                <div className="repo-list-main">
                  <Heading as="h2" variant="small">
                    {reviewSet.name}
                  </Heading>
                  <div className="repo-list-meta">
                    <span className="row">
                      <RepoIcon size={14} /> {reviewSet.repos.length} {reviewSet.repos.length === 1 ? 'repository' : 'repositories'}
                    </span>
                    <Label variant="secondary">/{reviewSet.branchRegex}/</Label>
                    <span className="row">
                      <GitBranchIcon size={14} /> target: <span className="mono">{reviewSet.targetBranch}</span>
                    </span>
                  </div>
                </div>
                <span className="mono" style={{ color: 'var(--fgColor-muted)' }}>
                  {reviewSet.repos.map((repo) => `${repo.host}/${repo.repo}`).join(', ')}
                </span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
