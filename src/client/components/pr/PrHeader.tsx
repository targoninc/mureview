import { ActionList, ActionMenu, BranchName, Button, IconButton, Label, Spinner } from '@primer/react';
import { UserAvatar } from '../UserAvatar';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CommentDiscussionIcon,
  ColumnsIcon,
  EyeClosedIcon,
  EyeIcon,
  FileDiffIcon,
  FileIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  GearIcon,
  ListUnorderedIcon,
  RowsIcon,
  SyncIcon,
} from '@primer/octicons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PrStatus, ReviewSetDetail, ReviewVote } from '../../../shared/types';
import { ReviewVoteButtons, voteOptions } from './ReviewVoteButtons';
import { repoLabel } from '../../../shared/types';

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
      return { variant: 'secondary', text: 'Nothing to merge' };
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
  fileMode: 'all' | 'single';
  onToggleFileMode: () => void;
  /** The header is folded to its last row, for distraction-free reading. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Viewed files hidden from the tree, while the hide setting is on. */
  hiddenViewedCount?: number;
  /** Whether the hidden viewed files are being shown anyway. */
  revealViewed?: boolean;
  onToggleRevealViewed?: () => void;
  /** Present when the review set has pull requests that take a decision. */
  reviewState?: ReviewVote | null;
  onVoteAll?: (vote: ReviewVote) => void;
  voting?: boolean;
  pendingVote?: ReviewVote | null;
  /** One row per underlying pull request, for the review state popover. */
  reviewRows?: Array<{
    key: string;
    label: string;
    vote: ReviewVote;
    reviewers?: Array<{ name: string; avatarUrl?: string; vote: ReviewVote; you?: boolean }>;
  }>;
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
  fileMode,
  onToggleFileMode,
  collapsed,
  onToggleCollapsed,
  hiddenViewedCount,
  revealViewed,
  onToggleRevealViewed,
  reviewState,
  onVoteAll,
  voting,
  pendingVote,
  reviewRows,
  progress,
  checksFailing,
  onOpenFiles,
  onOpenCommits,
  onOpenConversation,
  onShowPullRequests,
}: PrHeaderProps) {
  const navigate = useNavigate();
  const [reviewOpen, setReviewOpen] = useState(false);
  const { reviewSet, pr } = detail;
  const owned = detail.owned !== false;
  const canManage = detail.canManage;
  const state = stateVariant(pr.state);
  const openRepos = pr.repos.filter((repo) => repo.state === 'open');
  const openPullRequests = pr.repos.filter((repo) => repo.pullRequest).length;
  const skippedFiles = pr.repos.flatMap((repo) =>
    (repo.files ?? []).filter((file) => !file.patch).map((file) => `${repoLabel(repo)}: ${file.path}`),
  );
  const loadingRepos = progress !== null && progress.total > 0 && progress.loaded < progress.total;
  const showDiffRow = pr.state === 'loading' || pr.stats.files > 0;
  const collapseToggle = (
    <IconButton
      icon={collapsed ? ChevronDownIcon : ChevronUpIcon}
      aria-label={collapsed ? 'Expand the header' : 'Collapse the header'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand the header' : 'Collapse the header to just the summary row'}
      variant="invisible"
      size="small"
      onClick={onToggleCollapsed}
    />
  );
  const stackCount = new Set(openRepos.map((repo) => `${repo.connectionId}:${repo.repo}`)).size;
  const repoNoun =
    reviewSet.mode === 'stack' ? (openRepos.length === 1 ? 'layer' : 'layers') : openRepos.length === 1 ? 'branch' : 'branches';
  const targetLabel = <BranchName>{reviewSet.targetBranch}</BranchName>;

  return (
    <div className={`pr-header${collapsed ? ' collapsed' : ''}`}>
      <div className="pr-header-top">
        <div className="row pr-header-left">
          {collapseToggle}
          <div className="pr-header-titles">
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
                  compact ? (
                    <>
                      {openRepos.length} {repoNoun}
                      {reviewSet.mode === 'stack' ? ` · ${stackCount} ${stackCount === 1 ? 'stack' : 'stacks'}` : ''} →{' '}
                      {reviewSet.mode === 'per-repo' ? 'their targets' : targetLabel} · {reviewedCount}/{pr.stats.files} viewed
                    </>
                  ) : (
                    <>
                      {reviewSet.mode === 'stack' ? (
                        <>
                          {openRepos.length} {repoNoun} across {stackCount} {stackCount === 1 ? 'stack' : 'stacks'}, merging
                          bottom-up into {targetLabel}
                        </>
                      ) : (
                        <>
                          Merging {openRepos.length} {repoNoun}{' '}
                          {reviewSet.mode === 'per-repo' ? 'into their target branches' : <>into {targetLabel}</>}
                        </>
                      )}{' '}
                      · {pr.stats.files} files · {reviewedCount}/{pr.stats.files} viewed
                    </>
                  )
                ) : pr.state === 'closed' ? (
                  reviewSet.mode === 'per-repo' ? (
                    "Every matched branch is merged into its own target branch"
                  ) : (
                    <>Every matched branch is merged into {targetLabel}</>
                  )
                ) : compact ? (
                  reviewSet.mode === 'stack' ? (
                    <>Watching stacks → {targetLabel}</>
                  ) : reviewSet.mode === 'per-repo' ? (
                    "Watching every repository's branch"
                  ) : (
                    <>Target: {targetLabel}</>
                  )
                ) : (
                  <>
                    {reviewSet.mode === 'stack' ? (
                      <>Watching the stacks of every repository, merging bottom-up into {targetLabel}</>
                    ) : reviewSet.mode === 'per-repo' ? (
                      'Watching the selected branch of every repository'
                    ) : (
                      <>Target branch {targetLabel}</>
                    )}
                  </>
                )}
                {skippedFiles.length > 0 ? (
                  <>
                    {' · '}
                    <span title={skippedFiles.join('\n')} style={{ cursor: 'help' }}>
                      {skippedFiles.length} non-text {skippedFiles.length === 1 ? 'file' : 'files'} skipped
                    </span>
                  </>
                ) : null}
                {!owned && detail.owner ? ` · shared by ${detail.owner.name}` : ''}
              </span>
              </div>
          </div>
        </div>
        <div className="stack pr-header-right" style={{ gap: 0 }}>
          <div className="pr-header-actions-wrap">
            <div className="row pr-header-actions">
              {onVoteAll ? (
                <div className="row vote-group" style={{ gap: 4 }}>
                  <ReviewVoteButtons vote={reviewState ?? null} busy={voting} pending={pendingVote} onVote={onVoteAll} />
                  {reviewRows && reviewRows.length > 1 ? (
                    <ActionMenu open={reviewOpen} onOpenChange={setReviewOpen}>
                      <ActionMenu.Anchor>
                        <IconButton
                          icon={ChevronDownIcon}
                          aria-label="Show the review state of every pull request"
                          variant="invisible"
                          size="small"
                        />
                      </ActionMenu.Anchor>
                      <ActionMenu.Overlay width="medium">
                        <ActionList>
                          {reviewRows.map((row) => {
                            const option = voteOptions.find((entry) => entry.vote === row.vote) ?? voteOptions[1];
                            return (
                              <ActionList.Item key={row.key} onSelect={(event) => event.preventDefault()}>
                                <ActionList.LeadingVisual>
                                  <span className={option.className}>
                                    <option.icon size={14} />
                                  </span>
                                </ActionList.LeadingVisual>
                                <div className="vote-popover-row">
                                  <span className="mono">{row.label}</span>
                                  <span className="vote-popover-people">
                                    {(row.reviewers ?? []).map((reviewer) => {
                                      const state = voteOptions.find((entry) => entry.vote === reviewer.vote) ?? voteOptions[1];
                                      return (
                                        <span
                                          className="vote-popover-person"
                                          key={reviewer.name}
                                          title={`${reviewer.name}: ${state.label}`}
                                        >
                                          <UserAvatar src={reviewer.avatarUrl} name={reviewer.name} size={16} />
                                          <span className={state.className}>
                                            <state.icon size={12} />
                                          </span>
                                          <span className="vote-popover-name">{reviewer.you ? `${reviewer.name} (you)` : reviewer.name}</span>
                                        </span>
                                      );
                                    })}
                                  </span>
                                </div>
                                <ActionList.TrailingVisual>{option.label}</ActionList.TrailingVisual>
                              </ActionList.Item>
                            );
                          })}
                        </ActionList>
                      </ActionMenu.Overlay>
                    </ActionMenu>
                  ) : null}
                </div>
              ) : null}
              {compact ? (
                <>
                  <span className="icon-count">
                    <IconButton
                      icon={checksFailing ? AlertIcon : GitPullRequestIcon}
                      aria-label={checksFailing ? 'Pull requests, some checks are failing' : 'Pull requests'}
                      onClick={onShowPullRequests}
                    />
                    {openPullRequests > 0 ? <span className="icon-count-badge">{openPullRequests}</span> : null}
                  </span>
                  {pr.state === 'open' && canManage ? (
                    <IconButton icon={GitMergeIcon} variant="primary" aria-label="Merge" onClick={onMerge} />
                  ) : null}
                  <IconButton icon={FileDiffIcon} aria-label="Files" onClick={onOpenFiles} />
                  <span className="icon-count">
                    <IconButton icon={GitCommitIcon} aria-label={`Commits (${commitCount})`} onClick={onOpenCommits} />
                    {commitCount > 0 ? <span className="icon-count-badge">{commitCount}</span> : null}
                  </span>
                  <span className="icon-count">
                    <IconButton icon={CommentDiscussionIcon} aria-label={`Conversation (${commentCount})`} onClick={onOpenConversation} />
                    {commentCount > 0 ? <span className="icon-count-badge">{commentCount}</span> : null}
                  </span>
                  {canManage ? (
                    <IconButton icon={GearIcon} aria-label="Review set settings" onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)} />
                  ) : null}
                  {canManage ? <IconButton icon={SyncIcon} aria-label="Refresh" onClick={() => onReload(true)} /> : null}
                </>
              ) : (
                <>
                  <Button
                    leadingVisual={checksFailing ? AlertIcon : GitPullRequestIcon}
                    onClick={onShowPullRequests}
                    title={checksFailing ? 'Some pull request checks are failing' : undefined}
                  >
                    {openPullRequests > 0 ? `${openPullRequests} PR${openPullRequests === 1 ? '' : 's'} open` : 'No open PRs'}
                  </Button>
                  {pr.state === 'open' && canManage ? (
                    <Button variant="primary" leadingVisual={GitMergeIcon} onClick={onMerge}>
                      Merge
                    </Button>
                  ) : null}
                  {canManage ? (
                    <Button leadingVisual={GearIcon} onClick={() => navigate(`/review-sets/${reviewSet.id}/settings`)}>
                      Settings
                    </Button>
                  ) : null}
                  {canManage ? <IconButton icon={SyncIcon} aria-label="Refresh" onClick={() => onReload(true)} /> : null}
                </>
              )}
            </div>
            </div>
          {showDiffRow ? (
            <div className="row pr-header-diff-row" style={{ gap: 6, alignItems: 'center' }}>
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
              <IconButton
                icon={fileMode === 'all' ? FileIcon : ListUnorderedIcon}
                aria-label={fileMode === 'all' ? 'Switch to single file view' : 'Switch to all files at once'}
                variant="invisible"
                size="small"
                onClick={onToggleFileMode}
              />
              {hiddenViewedCount ? (
                <span className="icon-count">
                  <IconButton
                    icon={revealViewed ? EyeClosedIcon : EyeIcon}
                    aria-label={revealViewed ? 'Hide the viewed files again' : 'Show the viewed files hidden from the tree'}
                    title={
                      revealViewed
                        ? 'Hide the viewed files again'
                        : `Show the ${hiddenViewedCount} viewed ${hiddenViewedCount === 1 ? 'file' : 'files'} hidden from the tree`
                    }
                    variant="invisible"
                    size="small"
                    onClick={onToggleRevealViewed}
                  />
                  <span className="icon-count-badge">{hiddenViewedCount}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
