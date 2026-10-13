import { Button, IconButton, Label, Spinner } from '@primer/react';
import {
  AlertIcon,
  CommentDiscussionIcon,
  ColumnsIcon,
  FileDiffIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GearIcon,
  RowsIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { useNavigate } from 'react-router-dom';
import type { PrStatus, ReviewSetDetail } from '../../../shared/types';

type LabelVariant = 'default' | 'accent' | 'success' | 'attention' | 'danger' | 'done' | 'secondary';

function stateVariant(state: PrStatus['state']): { variant: LabelVariant; text: string } {
  switch (state) {
    case 'loading':
      return { variant: 'secondary', text: 'Loading' };
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
  diffStyle: 'unified' | 'split';
  onToggleDiffStyle: () => void;
  progress: { loaded: number; total: number } | null;
  checksFailing: boolean;
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
  diffStyle,
  onToggleDiffStyle,
  progress,
  checksFailing,
  onOpenFiles,
  onOpenCommits,
  onOpenConversation,
  onShowPullRequests,
}: PrHeaderProps) {
  const navigate = useNavigate();
  const { reviewSet, pr } = detail;
  const owned = detail.owned !== false;
  const state = stateVariant(pr.state);
  const openRepos = pr.repos.filter((repo) => repo.state === 'open');
  const openPullRequests = pr.repos.filter((repo) => repo.pullRequest).length;
  const skipped = pr.repos.reduce((count, repo) => count + (repo.files?.filter((file) => !file.patch).length ?? 0), 0);
  const loadingRepos = progress !== null && progress.total > 0 && progress.loaded < progress.total;

  return (
    <div className="pr-header">
      <div className="pr-header-top">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row">
            <h1 className="pr-title">{reviewSet.name}</h1>
            <Label variant={state.variant}>{state.text}</Label>
          </div>
          <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
            {loadingRepos && progress ? (
              <span className="row" style={{ gap: 6 }}>
                <Spinner size="small" aria-label="Loading repositories" />
                Loading repositories {progress.loaded}/{progress.total}
                <span
                  className="mini-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={progress.total}
                  aria-valuenow={progress.loaded}
                >
                  <span className="mini-progress-fill" style={{ width: `${Math.round((progress.loaded / progress.total) * 100)}%` }} />
                </span>
              </span>
            ) : openRepos.length > 0 ? (
              <>
                Merging {openRepos.length} {openRepos.length === 1 ? 'branch' : 'branches'}{' '}
                {reviewSet.mode === 'per-repo' ? (
                  'into their target branches'
                ) : (
                  <>
                    into <span className="mono">{reviewSet.targetBranch}</span>
                  </>
                )}{' '}
                · {pr.stats.files} files · {reviewedCount}/{pr.stats.files} viewed
              </>
            ) : (
              <>
                {reviewSet.mode === 'per-repo' ? (
                  'Watching the selected branch of every repository'
                ) : (
                  <>
                    Target branch <span className="mono">{reviewSet.targetBranch}</span>
                  </>
                )}
              </>
            )}
            {skipped > 0 ? ` · ${skipped} non-text files skipped` : ''}
            {!owned && detail.owner ? ` · shared by ${detail.owner.name}` : ''}
          </span>
        </div>
        <div className="stack pr-header-right" style={{ gap: 6 }}>
          <div className="row pr-header-actions">
            <Button
              leadingVisual={checksFailing ? AlertIcon : GitPullRequestIcon}
              onClick={onShowPullRequests}
              title={checksFailing ? 'Some pull request checks are failing' : undefined}
            >
              {openPullRequests > 0 ? `${openPullRequests} PR${openPullRequests === 1 ? '' : 's'} open` : 'No open PRs'}
            </Button>
            {pr.state === 'open' && owned ? (
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
                {owned ? (
                  <IconButton icon={GearIcon} aria-label="Review set settings" onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)} />
                ) : null}
                <IconButton icon={SyncIcon} aria-label="Refresh" onClick={() => onReload(true)} />
              </>
            ) : (
              <>
                {owned ? (
                  <Button leadingVisual={GearIcon} onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)}>
                    Settings
                  </Button>
                ) : null}
                <IconButton icon={SyncIcon} aria-label="Refresh" onClick={() => onReload(true)} />
              </>
            )}
          </div>
          {pr.state === 'loading' || pr.stats.files > 0 ? (
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              {pr.state === 'loading' ? (
                <span className="skeleton skeleton-diff" role="status" aria-label="Calculating the total diff" />
              ) : (
                <span className="pr-header-diff">
                  <span className="additions">+{pr.stats.additions}</span>{' '}
                  <span className="deletions">−{pr.stats.deletions}</span>
                </span>
              )}
              <IconButton
                icon={diffStyle === 'unified' ? ColumnsIcon : RowsIcon}
                aria-label={diffStyle === 'unified' ? 'Switch to split view' : 'Switch to unified view'}
                variant="invisible"
                size="small"
                onClick={onToggleDiffStyle}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
