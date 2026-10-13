import { useState } from 'react';
import { Avatar, Button, Flash, IconButton, Textarea, useConfirm } from '@primer/react';
import { TrashIcon } from '@primer/octicons-react';
import type { Comment } from '../../../shared/types';
import { del, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import type { Side } from './annotations';

export interface CommentAnchor {
  connectionId: number | null;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: Side | null;
}

export function CommentThread({ comments, onDeleted }: { comments: Comment[]; onDeleted: (id: number) => void }) {
  const confirm = useConfirm();

  const remove = async (id: number) => {
    const approved = await confirm({
      title: 'Delete this comment?',
      content: 'The comment will be permanently removed from this review.',
      confirmButtonContent: 'Delete',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    await del(`/comments/${id}`);
    onDeleted(id);
  };

  return (
    <div className="comment-thread">
      {comments.map((comment) => (
        <div className="comment" key={comment.id}>
          <div className="comment-header">
            <Avatar src={comment.author.avatarUrl} size={20} alt={comment.author.name} />
            <strong>{comment.author.name}</strong>
            <span>commented {timeAgo(comment.createdAt)}</span>
            {comment.source === 'forge' ? (
              <span title="Written on the forge pull request and imported here">· from forge</span>
            ) : comment.synced && comment.path ? (
              <span title="Mirrored to the forge pull request for this repository">· synced to forge</span>
            ) : null}
            <span style={{ flex: 1 }} />
            <IconButton icon={TrashIcon} aria-label="Delete comment" variant="invisible" size="small" onClick={() => remove(comment.id)} />
          </div>
          <div className="comment-body">{comment.body}</div>
        </div>
      ))}
    </div>
  );
}

export function CommentComposer({
  prId,
  anchor,
  placeholder,
  autoFocus,
  onCancel,
  onDone,
}: {
  prId: number;
  anchor: CommentAnchor;
  placeholder?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onDone: (comment: Comment) => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ comment: Comment }>(`/prs/${prId}/comments`, { ...anchor, body });
      setBody('');
      onDone(result.comment);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="composer">
      <Textarea
        block
        rows={3}
        value={body}
        placeholder={placeholder ?? 'Leave a comment'}
        autoFocus={autoFocus}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
        }}
      />
      {error ? <Flash variant="danger">{error}</Flash> : null}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        <Button variant="primary" disabled={busy || !body.trim()} onClick={submit}>
          {busy ? 'Commenting…' : 'Comment'}
        </Button>
      </div>
    </div>
  );
}
