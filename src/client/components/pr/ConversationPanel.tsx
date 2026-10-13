import type { Comment, RepoStatus } from '../../../shared/types';
import { CommentComposer, CommentThread } from './Comments';

interface ConversationPanelProps {
  prId: number | null;
  comments: Comment[];
  repos?: RepoStatus[];
  readOnly?: boolean;
  onAdded: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}

export function ConversationPanel({ prId, comments, repos, readOnly, onAdded, onDeleted }: ConversationPanelProps) {
  const general = comments.filter((comment) => !comment.path);
  if (!prId) return null;

  return (
    <div className="conversation">
      {readOnly ? null : (
        <CommentComposer
          prId={prId}
          anchor={{ connectionId: null, repo: null, path: null, line: null, side: null }}
          placeholder="Start a conversation on this pull request"
          onDone={onAdded}
        />
      )}
      {general.length === 0 ? (
        <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
          {readOnly ? 'No general comments.' : 'No general comments yet.'}
        </span>
      ) : (
        <CommentThread prId={prId} comments={general} repos={repos} readOnly={readOnly} onAdded={onAdded} onDeleted={onDeleted} />
      )}
    </div>
  );
}
