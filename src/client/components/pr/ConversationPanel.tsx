import { useMemo } from 'react';
import type { Comment, RepoStatus } from '../../../shared/types';
import { repoLabel } from '../../../shared/types';
import { groupThreads } from './annotations';
import { CommentComposer, CommentThread } from './Comments';
import { parseItemId, repoItemKey } from '../../lib/format';
import { codeSnippet } from '../../lib/snippet';

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
 * mixing comments from different pull requests together. Line comments keep
 * their code snippet above the thread, the way Azure DevOps shows them.
 */
export function ConversationPanel({ prId, comments, repos, onAdded, onDeleted }: ConversationPanelProps) {
  const groups = useMemo(() => {
    const general = comments.filter((comment) => !comment.path);
    const byKey = new Map<string, ConversationGroup>();

    for (const comment of general) {
      const key = comment.connectionId === null || !comment.repo ? 'review-set' : repoItemKey({ connectionId: comment.connectionId, repo: comment.repo, position: comment.position });
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

  // Line comments, grouped by pull request and then by file.
  const lineGroups = useMemo(() => {
    const threads = groupThreads(comments);
    const byKey = new Map<string, Map<string, Array<{ threadKey: string; line: number; side: 'additions' | 'deletions'; comments: Comment[] }>>>();
    for (const list of threads.values()) {
      for (const thread of list) {
        const key = repoItemKey(thread);
        const files = byKey.get(key) ?? new Map();
        const entries = files.get(thread.path) ?? [];
        entries.push({ threadKey: thread.threadKey, line: thread.line, side: thread.side, comments: thread.comments });
        files.set(thread.path, entries);
        byKey.set(key, files);
      }
    }
    return byKey;
  }, [comments]);

  const snippetFor = (repo: RepoStatus | undefined, path: string, line: number, side: 'additions' | 'deletions') => {
    const file = repo?.files?.find((entry) => entry.path === path);
    if (!file?.patch) return null;
    return codeSnippet(file.patch, line, side);
  };

  const fileThreads = (key: string, repo: RepoStatus | undefined) => {
    const files = lineGroups.get(key);
    if (!files) return null;
    return [...files.entries()].map(([path, entries]) => (
      <div className="conversation-file" key={path}>
        <div className="conversation-file-label mono" title={path}>
          {path}
        </div>
        {entries.map((entry) => {
          const snippet = snippetFor(repo, path, entry.line, entry.side);
          return (
            <div className="conversation-snippet" key={entry.threadKey}>
              {snippet ? (
                <div className="code-snippet mono">
                  {snippet.lines.map((line) => (
                    <div
                      key={`${line.number}:${line.kind}`}
                      className={`code-snippet-line${line.target ? ' code-snippet-target' : ''}${line.kind === 'addition' ? ' code-snippet-addition' : ''}${line.kind === 'deletion' ? ' code-snippet-deletion' : ''}`}
                    >
                      <span className="code-snippet-number">{line.number}</span>
                      <span className="code-snippet-text">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <CommentThread prId={prId} comments={entry.comments} repos={repos} onAdded={onAdded} onDeleted={onDeleted} />
            </div>
          );
        })}
      </div>
    ));
  };

  if (!prId) return null;
  const reviewSetGroup = groups.find((group) => group.key === 'review-set');
  const lineKeys = [...lineGroups.keys()].filter((key) => !groups.some((group) => group.key === key));

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
          {fileThreads(group.key, repos?.find((repo) => group.context && repo.connectionId === group.context.connectionId && repo.repo === group.context.repo && repo.position === group.context.position))}
        </div>
      ))}
      {lineKeys.map((key) => {
        const { connectionId, repo, position } = parseItemId(`${key}:`);
        const status = repos?.find(
          (entry) => entry.connectionId === connectionId && entry.repo === repo && entry.position === position,
        );
        const stacked = (repos ?? []).some((entry) => entry.position > 0);
        const where = status ? repoLabel(status) : repo;
        return (
          <div className="conversation-group" key={key}>
            <div className="conversation-group-label">{stacked ? `${where} · layer ${Number(position) + 1}` : where}</div>
            {fileThreads(key, status)}
          </div>
        );
      })}
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
