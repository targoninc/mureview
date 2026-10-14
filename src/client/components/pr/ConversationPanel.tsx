import { useMemo } from 'react';
import type { Comment, RepoStatus } from '../../../shared/types';
import { repoLabel } from '../../../shared/types';
import { CommentComposer, CommentThread } from './Comments';

interface ConversationPanelProps {
  prId: number | null;
  comments: Comment[];
  repos?: RepoStatus[];
  onAdded: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}

interface ConversationGroup {
  key: string;
  label: string | null;
  context?: { connectionId: number; repo: string; position: number };
  comments: Comment[];
}

/**
 * General comments belong to the pull request they were written on, so the
 * conversation shows one thread per repository (and stack layer) instead of
 * mixing comments from different pull requests together.
 */
export function ConversationPanel({ prId, comments, repos, onAdded, onDeleted }: ConversationPanelProps) {
  const groups = useMemo(() => {
    const general = comments.filter((comment) => !comment.path);
    const byKey = new Map<string, ConversationGroup>();

    for (const comment of general) {
      const key = comment.connectionId === null || !comment.repo ? 'review-set' : `${comment.connectionId}:${comment.repo}:${comment.position}`;
      const group = byKey.get(key) ?? {
        key,
        label: null,
        context:
          comment.connectionId === null || !comment.repo
            ? undefined
            : { connectionId: comment.connectionId, repo: comment.repo, position: comment.position },
        comments: [],
      };
      group.comments.push(comment);
      byKey.set(key, group);
    }

    // Name each group after its repository, and its layer when the review set
    // is stacked.
    const ordered = [...byKey.values()].sort((a, b) => (a.key === 'review-set' ? 1 : b.key === 'review-set' ? -1 : a.key.localeCompare(b.key)));
    const stacked = (repos ?? []).some((repo) => repo.position > 0);
    for (const group of ordered) {
      if (!group.context) continue;
      const status = repos?.find(
        (repo) => repo.connectionId === group.context!.connectionId && repo.repo === group.context!.repo && repo.position === group.context!.position,
      );
      const where = status ? repoLabel(status) : group.context.repo;
      group.label = stacked ? `${where} · layer ${group.context.position + 1}` : where;
    }
    return ordered;
  }, [comments, repos]);

  if (!prId) return null;
  const reviewSetGroup = groups.find((group) => group.key === 'review-set');

  return (
    <div className="conversation">
      {groups.map((group) => (
        <div className="conversation-group" key={group.key}>
          {group.label ? <div className="conversation-group-label">{group.label}</div> : null}
          <CommentThread
            prId={prId}
            comments={group.comments}
            repos={repos}
            context={group.context}
            onAdded={onAdded}
            onDeleted={onDeleted}
          />
        </div>
      ))}
      {!reviewSetGroup ? (
        <CommentComposer
          prId={prId}
          anchor={{ connectionId: null, repo: null, path: null, line: null, side: null }}
          placeholder="Start a conversation on this pull request"
          onDone={onAdded}
        />
      ) : null}
    </div>
  );
}
