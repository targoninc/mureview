import type { Comment, RepoStatus } from '../../../shared/types';
import { CommentComposer, CommentThread } from './Comments';

interface ConversationPanelProps {
  prId: number | null;
  comments: Comment[];
  repos?: RepoStatus[];
  onAdded: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}

export function ConversationPanel({ prId, comments, repos, onAdded, onDeleted }: ConversationPanelProps) {
  const general = comments.filter((comment) => !comment.path);
  if (!prId) return null;

  return (
    <div className="conversation">
      {general.length === 0 ? (
        <CommentComposer
          prId={prId}
          anchor={{ connectionId: null, repo: null, path: null, line: null, side: null }}
          placeholder="Start a conversation on this pull request"
          onDone={onAdded}
        />
      ) : (
        <CommentThread prId={prId} comments={general} repos={repos} onAdded={onAdded} onDeleted={onDeleted} />
      )}
    </div>
  );
}
