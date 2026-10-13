import { useState, type ReactNode } from 'react';
import { Avatar, Button, Flash, IconButton, Textarea, useConfirm } from '@primer/react';
import { LinkExternalIcon, ReplyIcon, TrashIcon } from '@primer/octicons-react';
import type { Comment, RepoStatus } from '../../../shared/types';
import { del, post } from '../../lib/api';
import { useAppContext } from '../../lib/appContext';
import { forgeCommentLink, timeAgo } from '../../lib/format';
import { serviceNames } from '../ServiceIcon';
import type { Side } from './annotations';

export interface CommentAnchor {
  connectionId: number | null;
  repo: string | null;
  path: string | null;
  line: number | null;
  side: Side | null;
}

const generalAnchor: CommentAnchor = { connectionId: null, repo: null, path: null, line: null, side: null };

export function CommentThread({
  prId,
  comments,
  repos,
  canModerate,
  onAdded,
  onDeleted,
}: {
  prId: number | null;
  comments: Comment[];
  repos?: RepoStatus[];
  /** True for the owner of the review set, who may delete any comment. */
  canModerate?: boolean;
  onAdded?: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}) {
  const confirm = useConfirm();
  const { user } = useAppContext();
  const [replyingTo, setReplyingTo] = useState<number | null>(null);

  const remove = async (id: number, hasReplies: boolean) => {
    const approved = await confirm({
      title: 'Delete this comment?',
      content: hasReplies
        ? 'The comment and its replies will be permanently removed from this review.'
        : 'The comment will be permanently removed from this review.',
      confirmButtonContent: 'Delete',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    await del(`/comments/${id}`);
    onDeleted(id);
  };

  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  const replies = new Map<number, Comment[]>();
  const roots: Comment[] = [];
  for (const comment of comments) {
    const parent = comment.parentId !== null ? byId.get(comment.parentId) : undefined;
    if (parent) replies.set(parent.id, [...(replies.get(parent.id) ?? []), comment]);
    else roots.push(comment);
  }

  const anchorOf = (comment: Comment): CommentAnchor =>
    comment.path ? { connectionId: comment.connectionId, repo: comment.repo, path: comment.path, line: comment.line, side: comment.side } : generalAnchor;

  const renderComment = (comment: Comment, depth: number): ReactNode => {
    const link = repos ? forgeCommentLink(repos, comment) : null;
    const children = replies.get(comment.id) ?? [];
    const canReply = prId !== null && onAdded !== undefined;
    const canDelete = canModerate === true || (comment.authorId !== null && comment.authorId === user?.id);
    return (
      <div className={`comment${depth > 0 ? ' comment-nested' : ''}`} key={comment.id}>
        <div className="comment-header">
          <Avatar src={comment.author.avatarUrl} size={20} alt={comment.author.name} />
          <strong>{comment.author.name}</strong>
          <span>{comment.parentId ? 'replied' : 'commented'} {timeAgo(comment.createdAt)}</span>
          {comment.source === 'forge' ? (
            <span title="Written on the forge pull request and imported here">· from forge</span>
          ) : comment.synced && comment.path ? (
            <span title="Mirrored to the forge pull request for this repository">· synced to forge</span>
          ) : null}
          <span style={{ flex: 1 }} />
          {link ? (
            <a
              className="comment-forge-link"
              href={link.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open comment on ${serviceNames[link.kind]}`}
              title={`Open comment on ${serviceNames[link.kind]}`}
            >
              <LinkExternalIcon size={14} />
            </a>
          ) : null}
          {canReply ? (
            <IconButton
              icon={ReplyIcon}
              aria-label="Reply to comment"
              variant="invisible"
              size="small"
              onClick={() => setReplyingTo((current) => (current === comment.id ? null : comment.id))}
            />
          ) : null}
          {canDelete ? (
            <IconButton
              icon={TrashIcon}
              aria-label="Delete comment"
              variant="invisible"
              size="small"
              onClick={() => remove(comment.id, children.length > 0)}
            />
          ) : null}
        </div>
        <div className="comment-body">{comment.body}</div>
        {replyingTo === comment.id && canReply ? (
          <div className="comment-reply-composer">
            <CommentComposer
              prId={prId}
              anchor={anchorOf(comment)}
              parentId={comment.id}
              placeholder="Write a reply"
              autoFocus
              onCancel={() => setReplyingTo(null)}
              onDone={(reply) => {
                setReplyingTo(null);
                onAdded?.(reply);
              }}
            />
          </div>
        ) : null}
        {children.map((child) => renderComment(child, depth + 1))}
      </div>
    );
  };

  return <div className="comment-thread">{roots.map((comment) => renderComment(comment, 0))}</div>;
}

export function CommentComposer({
  prId,
  anchor,
  parentId,
  placeholder,
  autoFocus,
  onCancel,
  onDone,
}: {
  prId: number;
  anchor: CommentAnchor;
  parentId?: number;
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
      const result = await post<{ comment: Comment }>(`/prs/${prId}/comments`, { ...anchor, parentId: parentId ?? null, body });
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
          {busy ? 'Commenting…' : parentId ? 'Reply' : 'Comment'}
        </Button>
      </div>
    </div>
  );
}
