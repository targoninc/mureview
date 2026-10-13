import { Button, IconButton, Label } from '@primer/react';
import { CommentDiscussionIcon, FileDiffIcon, GitCommitIcon, GitMergeIcon, GitPullRequestIcon, PencilIcon, SyncIcon } from '@primer/octicons-react';
import { useNavigate } from 'react-router-dom';
import type { PrStatus, ReviewSetDetail } from '../../../shared/types';

type LabelVariant = 'default' | 'accent' | 'success' | 'attention' | 'danger' | 'done' | 'secondary';

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

interface PrHeaderProps {
  detail: ReviewSetDetail;
  onReload: (fresh?: boolean) => void;
  onMerge: () => void;
  reviewedCount: number;
  compact: boolean;
  commentCount: number;
  commitCount: number;
  onOpenFiles: () => void;
  onOpenCommits: () => void;
  onOpenConversation: () => void;
  onShowPullRequests: () => void;
}

export function PrHeader({
  detail,
  onReload,
  onMerge,
  reviewedCount,
  compact,
  commentCount,
  commitCount,
  onOpenFiles,
  onOpenCommits,
  onOpenConversation,
  onShowPullRequests,
}: PrHeaderProps) {
  const navigate = useNavigate();
  const { reviewSet, pr } = detail;
  const state = stateVariant(pr.state);
  const openRepos = pr.repos.filter((repo) => repo.state === 'open');
  const openPullRequests = pr.repos.filter((repo) => repo.pullRequest).length;
  const skipped = pr.repos.reduce((count, repo) => count + (repo.files?.filter((file) => !file.patch).length ?? 0), 0);

  return (
    <div className="pr-header">
      <div className="pr-header-top">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <h1 className="pr-title">{reviewSet.name}</h1>
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
        <div className="row pr-header-actions">
          {pr.state === 'open' ? (
            <Button variant="primary" leadingVisual={GitMergeIcon} onClick={onMerge}>
              Merge
            </Button>
          ) : null}
          {compact ? (
            <>
              <Button leadingVisual={FileDiffIcon} onClick={onOpenFiles}>
                Files
              </Button>
              <Button leadingVisual={GitCommitIcon} onClick={onOpenCommits}>
                Commits ({commitCount})
              </Button>
              <Button leadingVisual={CommentDiscussionIcon} onClick={onOpenConversation}>
                Conversation ({commentCount})
              </Button>
              <IconButton icon={PencilIcon} aria-label="Review set settings" onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)} />
              <IconButton icon={SyncIcon} aria-label="Refresh" onClick={() => onReload(true)} />
            </>
          ) : (
            <>
              <Button leadingVisual={PencilIcon} onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)}>
                Settings
              </Button>
              <Button leadingVisual={SyncIcon} onClick={() => onReload(true)}>
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="row pr-header-chips">
        <Button size="small" leadingVisual={GitPullRequestIcon} onClick={onShowPullRequests}>
          {openPullRequests > 0 ? `${openPullRequests} PR${openPullRequests === 1 ? '' : 's'} open` : 'No open pull requests'}
        </Button>
      </div>
    </div>
  );
}
