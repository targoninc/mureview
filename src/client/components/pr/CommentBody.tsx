import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { GitPullRequestIcon, IssueOpenedIcon } from '@primer/octicons-react';
import type { RefInfo, RepoStatus } from '../../../shared/types';
import { api } from '../../lib/api';
import { renderInlineMarkdown, splitCodeFences } from '../../lib/markdown';
import { fallbackRefUrl, findItemRefs, findMentions, type ItemRef, type MentionRef } from '../../lib/refs';

const resolutions = new Map<string, Promise<RefInfo | null>>();

function resolveRef(connectionId: number, repo: string, ref: ItemRef): Promise<RefInfo | null> {
  const key = `${connectionId}#${ref.type}#${repo}#${ref.id}`;
  let promise = resolutions.get(key);
  if (!promise) {
    const query = `connectionId=${connectionId}&repo=${encodeURIComponent(repo)}&type=${ref.type}&id=${ref.id}`;
    promise = api<{ ref: RefInfo | null }>(`/refs?${query}`)
      .then((result) => result.ref)
      .catch(() => null);
    resolutions.set(key, promise);
  }
  return promise;
}

const mentionResolutions = new Map<string, Promise<{ name: string; url?: string } | null>>();

function resolveMention(connectionId: number, id: string): Promise<{ name: string; url?: string } | null> {
  const key = `${connectionId}#${id}`;
  let promise = mentionResolutions.get(key);
  if (!promise) {
    promise = api<{ mention: { name: string; url?: string } | null }>(`/mentions?connectionId=${connectionId}&id=${encodeURIComponent(id)}`)
      .then((result) => result.mention)
      .catch(() => null);
    mentionResolutions.set(key, promise);
  }
  return promise;
}

/** A single reference, upgraded from a plain link to a forge-style chip once resolved. */
function RefChip({ connectionId, repo, ref, status }: { connectionId: number; repo: string; ref: ItemRef; status: RepoStatus }) {
  const [info, setInfo] = useState<RefInfo | null>(null);

  useEffect(() => {
    let active = true;
    resolveRef(connectionId, repo, ref).then((result) => {
      if (active) setInfo(result);
    });
    return () => {
      active = false;
    };
  }, [connectionId, repo, ref.type, ref.id]);

  if (!info) {
    const url = fallbackRefUrl(ref, status);
    if (!url) return <>{ref.text}</>;
    return (
      <a className="comment-ref" href={url} target="_blank" rel="noreferrer">
        {ref.text}
      </a>
    );
  }

  const Icon = info.kind === 'pr' ? GitPullRequestIcon : IssueOpenedIcon;
  const label = info.kind === 'pr' ? `PR ${ref.id}` : `#${ref.id}`;
  return (
    <a className="comment-ref-chip" href={info.url} target="_blank" rel="noreferrer" title={info.title || undefined}>
      <Icon size={14} />
      <span className="comment-ref-chip-text">
        {label}
        {info.title ? `: ${info.title}` : ''}
      </span>
    </a>
  );
}

/** A forge mention like Azure DevOps's `@<identity-id>`, shown as `@Name`. */
function MentionChip({ connectionId, mention }: { connectionId: number; mention: MentionRef }) {
  const [info, setInfo] = useState<{ name: string; url?: string } | null>(null);

  useEffect(() => {
    let active = true;
    resolveMention(connectionId, mention.id).then((result) => {
      if (active) setInfo(result);
    });
    return () => {
      active = false;
    };
  }, [connectionId, mention.id]);

  if (!info) return <>{mention.text}</>;
  const label = `@${info.name}`;
  if (!info.url) return <span className="comment-mention">{label}</span>;
  return (
    <a className="comment-mention" href={info.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

/**
 * A comment body: fenced code blocks, then the forge's own syntax — references
 * like `#123` and `!123`, Azure DevOps `@<identity-id>` mentions — and the
 * markdown around them.
 */
export function CommentBody({
  body,
  repos,
  repo,
}: {
  body: string;
  repos?: RepoStatus[];
  repo: { connectionId: number | null; repo: string | null };
}) {
  const status =
    repos && repo.connectionId !== null && repo.repo
      ? repos.find((entry) => entry.connectionId === repo.connectionId && entry.repo === repo.repo)
      : undefined;

  const nodes: ReactNode[] = [];
  splitCodeFences(body).forEach((segment, segmentIndex) => {
    if (segment.kind === 'code') {
      nodes.push(
        <pre className="comment-code-block" key={`code-${segmentIndex}`}>
          <code>{segment.code}</code>
        </pre>,
      );
      return;
    }
    if (!status) {
      nodes.push(<Fragment key={`text-${segmentIndex}`}>{renderInlineMarkdown(segment.text, `s${segmentIndex}`)}</Fragment>);
      return;
    }

    const tokens: (ItemRef | MentionRef)[] = [...findItemRefs(segment.text, status), ...findMentions(segment.text, status)].sort(
      (a, b) => a.start - b.start,
    );
    let cursor = 0;
    tokens.forEach((token, tokenIndex) => {
      if (token.start > cursor) {
        nodes.push(
          <Fragment key={`t-${segmentIndex}-${tokenIndex}`}>
            {renderInlineMarkdown(segment.text.slice(cursor, token.start), `s${segmentIndex}t${tokenIndex}`)}
          </Fragment>,
        );
      }
      if ('type' in token) {
        nodes.push(
          <RefChip
            key={`ref-${segmentIndex}-${tokenIndex}`}
            connectionId={status.connectionId}
            repo={status.repo}
            ref={token}
            status={status}
          />,
        );
      } else {
        nodes.push(<MentionChip key={`mention-${segmentIndex}-${tokenIndex}`} connectionId={status.connectionId} mention={token} />);
      }
      cursor = token.end;
    });
    if (cursor < segment.text.length) {
      nodes.push(
        <Fragment key={`tail-${segmentIndex}`}>{renderInlineMarkdown(segment.text.slice(cursor), `s${segmentIndex}tail`)}</Fragment>,
      );
    }
  });

  return <>{nodes}</>;
}
