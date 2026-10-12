import { Button, Heading, Label } from '@primer/react';
import { GitMergeIcon, PencilIcon, SyncIcon } from '@primer/octicons-react';
import { useNavigate } from 'react-router-dom';
import type { PrStatus, RepoStatus, ReviewSetDetail } from '../../../shared/types';
import { repoStatusText } from '../../lib/format';

type LabelVariant = 'default' | 'accent' | 'success' | 'attention' | 'danger' | 'done' | 'secondary';

function repoVariant(repo: RepoStatus): LabelVariant {
  if (repo.state === 'open') return 'success';
  if (repo.state === 'error') return 'danger';
  if (repo.state === 'merged') return 'done';
  if (repo.matches.length > 1) return 'danger';
  return 'secondary';
}

function stateVariant(state: PrStatus['state']): { variant: LabelVariant; text: string } {
  switch (state) {
    case 'open':
      return { variant: 'success', text: 'Open' };
    case 'invalid':
      return { variant: 'danger', text: 'Invalid configuration' };
    case 'closed':
      return { variant: 'done', text: 'Closed' };
    default:
      return { variant: 'secondary', text: 'Draft' };
  }
}

function RepoChip({ repo }: { repo: RepoStatus }) {
  const kindLabel = repo.kind === 'github' ? '' : repo.kind === 'ado' ? 'azure devops · ' : `${repo.kind} · `;
  return (
    <Label variant={repoVariant(repo)}>
      {kindLabel}
      {repo.host}/{repo.repo}
      {repo.branch ? ` · ${repo.branch}` : ''} — {repoStatusText(repo)}
    </Label>
  );
}

interface PrHeaderProps {
  detail: ReviewSetDetail;
  onReload: (fresh?: boolean) => void;
  onMerge: () => void;
  merging: boolean;
  reviewedCount: number;
}

export function PrHeader({ detail, onReload, onMerge, merging, reviewedCount }: PrHeaderProps) {
  const navigate = useNavigate();
  const { reviewSet, pr } = detail;
  const state = stateVariant(pr.state);
  const openRepos = pr.repos.filter((repo) => repo.state === 'open');
  const skipped = pr.repos.reduce((count, repo) => count + (repo.files?.filter((file) => !file.patch).length ?? 0), 0);

  return (
    <div className="pr-header">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <Heading as="h1" variant="medium">
              {reviewSet.name}
            </Heading>
            <Label variant={state.variant}>{state.text}</Label>
          </div>
          <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
            {openRepos.length > 0 ? (
              <>
                Merging {openRepos.length} {openRepos.length === 1 ? 'branch' : 'branches'} into{' '}
                <span className="mono">{reviewSet.targetBranch}</span> · {pr.stats.files} files{' '}
                <span className="additions">+{pr.stats.additions}</span> <span className="deletions">−{pr.stats.deletions}</span> ·{' '}
                {reviewedCount}/{pr.stats.files} viewed
              </>
            ) : (
              <>
                Target branch <span className="mono">{reviewSet.targetBranch}</span>
              </>
            )}
            {skipped > 0 ? ` · ${skipped} non-text files skipped` : ''}
          </span>
        </div>
        <div className="row">
          {pr.state === 'open' ? (
            <Button variant="primary" leadingVisual={GitMergeIcon} onClick={onMerge} loading={merging}>
              Merge
            </Button>
          ) : null}
          <Button leadingVisual={PencilIcon} onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)}>
            Settings
          </Button>
          <Button leadingVisual={SyncIcon} onClick={() => onReload(true)}>
            Refresh
          </Button>
        </div>
      </div>
      <div className="row">
        {pr.repos.map((repo) => (
          <RepoChip key={`${repo.connectionId}:${repo.repo}`} repo={repo} />
        ))}
      </div>
    </div>
  );
}
