import { useState } from 'react';
import { Avatar, Button, Flash, IconButton, Label, Textarea, useConfirm } from '@primer/react';
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  IssueReopenedIcon,
  LinkExternalIcon,
  TrashIcon,
} from '@primer/octicons-react';
import type { Comment, RepoStatus } from '../../../shared/types';
import { del, post } from '../../lib/api';
import { useAppContext } from '../../lib/appContext';
import { forgeCommentLink, timeAgo } from '../../lib/format';
import { serviceNames } from '../ServiceIcon';
import { CommentBody } from './CommentBody';
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
  onAdded,
  onDeleted,
}: {
  prId: number | null;
  comments: Comment[];
  repos?: RepoStatus[];
  onAdded?: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}) {
  const confirm = useConfirm();
  const { user } = useAppContext();
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [discussionCollapsed, setDiscussionCollapsed] = useState(false);

  const toggleCollapsed = (id: number) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = async (id: number) => {
    const approved = await confirm({
      title: 'Delete this comment?',
      content: 'The comment will be permanently removed from this review and on the forge.',
      confirmButtonContent: 'Delete',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    setError(null);
    try {
      await del(`/comments/${id}`);
      onDeleted(id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const anchored = comments.find((comment) => comment.path);
  const anchor: CommentAnchor = anchored
    ? {
        connectionId: anchored.connectionId,
        repo: anchored.repo,
        path: anchored.path,
        line: anchored.line,
        side: anchored.side,
      }
    : generalAnchor;
  // Replies answer the whole thread: continue the forge thread of the first
  // comment that exists there, otherwise the first comment.
  const parent = comments.find((comment) => comment.forgeCommentId) ?? comments[0];
  const [resolvedOverride, setResolvedOverride] = useState<boolean | null>(null);

  const parentRepo =
    repos && parent?.connectionId !== null && parent?.repo
      ? repos.find((entry) => entry.connectionId === parent.connectionId && entry.repo === parent.repo)
      : undefined;
  const canResolve = Boolean(
    parent?.forgeCommentId && parentRepo && (parentRepo.kind === 'ado' || (parentRepo.kind === 'github' && parent.path)),
  );
  const resolved = resolvedOverride ?? parent?.resolved ?? false;

  const toggleResolved = async () => {
    if (!parent) return;
    try {
      await post(`/comments/${parent.id}/resolve`, { resolved: !resolved });
      setResolvedOverride(!resolved);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="comment-thread">
      {comments.length > 1 ? (
        <button
          type="button"
          className="comment-thread-toggle"
          aria-expanded={!discussionCollapsed}
          aria-label={discussionCollapsed ? 'Expand discussion' : 'Collapse discussion'}
          onClick={() => setDiscussionCollapsed((current) => !current)}
        >
          {discussionCollapsed ? <ChevronRightIcon size={12} /> : <ChevronDownIcon size={12} />}
          {comments.length} comments
        </button>
      ) : null}
      {discussionCollapsed ? null : (
        <>
          {error ? <Flash variant="danger">{error}</Flash> : null}
          {comments.map((comment) => {
        const link = repos ? forgeCommentLink(repos, comment) : null;
        const canDelete = comment.authorId !== null && comment.authorId === user?.id;
        const isCollapsed = collapsed.has(comment.id);
        return (
          <div className="comment" key={comment.id}>
            <div className="comment-header">
              <IconButton
                icon={isCollapsed ? ChevronRightIcon : ChevronDownIcon}
                aria-label={isCollapsed ? 'Expand comment' : 'Collapse comment'}
                variant="invisible"
                size="small"
                onClick={() => toggleCollapsed(comment.id)}
              />
              <Avatar src={comment.author.avatarUrl} size={20} alt={comment.author.name} />
              <strong>{comment.author.name}</strong>
              <span>{timeAgo(comment.createdAt)}</span>
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
              {canResolve && comment.id === parent?.id ? (
                <>
                  {resolved ? <Label variant="success">resolved</Label> : null}
                  <IconButton
                    icon={resolved ? IssueReopenedIcon : CheckCircleIcon}
                    aria-label={resolved ? 'Reactivate conversation' : 'Resolve conversation'}
                    variant="invisible"
                    size="small"
                    onClick={toggleResolved}
                  />
                </>
              ) : null}
              {canDelete ? (
                <IconButton
                  icon={TrashIcon}
                  aria-label="Delete comment"
                  variant="invisible"
                  size="small"
                  onClick={() => remove(comment.id)}
                />
              ) : null}
            </div>
            {isCollapsed ? null : (
              <div className="comment-body">
                <CommentBody body={comment.body} repos={repos} repo={comment} />
              </div>
            )}
          </div>
        );
          })}
          {prId !== null && onAdded ? (
            <div className="comment-reply-composer">
              <CommentComposer prId={prId} anchor={anchor} parentId={parent?.id} placeholder="Reply" onDone={onAdded} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
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
