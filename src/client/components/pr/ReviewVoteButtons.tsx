import { Button, Spinner } from '@primer/react';
import { CheckCircleIcon, ClockIcon, XCircleIcon } from '@primer/octicons-react';
import type { ReviewVote } from '../../../shared/types';

const options: Array<{ vote: ReviewVote; label: string; icon: typeof CheckCircleIcon; className: string }> = [
  { vote: 'approve', label: 'Approve', icon: CheckCircleIcon, className: 'vote-icon-approve' },
  { vote: 'waiting', label: 'Waiting', icon: ClockIcon, className: 'vote-icon-waiting' },
  { vote: 'reject', label: 'Reject', icon: XCircleIcon, className: 'vote-icon-reject' },
];

/** Approve / waiting / reject with coloured icons and plain buttons. */
export function ReviewVoteButtons({
  vote,
  busy,
  pending,
  onVote,
}: {
  vote: ReviewVote | null;
  busy?: boolean;
  /** The decision currently being written to the forge. */
  pending?: ReviewVote | null;
  onVote: (vote: ReviewVote) => void;
}) {
  return (
    <div className="row vote-buttons" style={{ gap: 4 }}>
      {options.map((option) => (
        <Button
          key={option.vote}
          size="small"
          className={vote === option.vote ? 'vote-button vote-button-active' : 'vote-button'}
          disabled={busy}
          leadingVisual={
            pending === option.vote ? (
              <Spinner size="small" aria-label="Syncing the review decision" />
            ) : (
              <span className={option.className}>
                <option.icon size={14} />
              </span>
            )
          }
          onClick={() => onVote(option.vote)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
