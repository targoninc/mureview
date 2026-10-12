import type { Comment } from '../../../shared/types';
import { CommentComposer, CommentThread } from './Comments';

interface ConversationPanelProps {
  prId: number | null;
  comments: Comment[];
  onAdded: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}

export function ConversationPanel({ prId, comments, onAdded, onDeleted }: ConversationPanelProps) {
  const general = comments.filter((comment) => !comment.path);
  if (!prId) return null;

  return (
    <div className="conversation">
      <CommentComposer
        prId={prId}
        anchor={{ repo: null, path: null, line: null, side: null }}
        placeholder="Start a conversation on this pull request"
        onDone={onAdded}
      />
      {general.length === 0 ? (
        <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>No general comments yet.</span>
      ) : (
        general.map((comment) => <CommentThread key={comment.id} comments={[comment]} onDeleted={onDeleted} />)
      )}
    </div>
  );
}
