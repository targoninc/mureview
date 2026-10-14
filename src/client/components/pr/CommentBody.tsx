import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { GitPullRequestIcon, IssueOpenedIcon } from '@primer/octicons-react';
import type { RefInfo, RepoStatus } from '../../../shared/types';
import { api } from '../../lib/api';
import { MENTION_SCHEME, REF_SCHEME, preprocessBody } from '../../lib/markdown';
import { fallbackRefUrl, type ItemRef, type MentionRef } from '../../lib/refs';

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

/** Links the preprocessor rewrote become chips; the rest stay ordinary links. */
function BodyLink({ href, children, status }: { href?: string; children?: ReactNode; status: RepoStatus | undefined }) {
  if (href?.startsWith(REF_SCHEME)) {
    const [type, id] = href.slice(REF_SCHEME.length).split(':');
    if (!status || !id || (type !== 'pr' && type !== 'issue' && type !== 'work')) return <>{children}</>;
    return (
      <RefChip
        connectionId={status.connectionId}
        repo={status.repo}
        ref={{ start: 0, end: 0, text: String(children ?? ''), id, type }}
        status={status}
      />
    );
  }
  if (href?.startsWith(MENTION_SCHEME)) {
    if (!status) return <>{children}</>;
    return <MentionChip connectionId={status.connectionId} mention={{ start: 0, end: 0, text: String(children ?? ''), id: href.slice(MENTION_SCHEME.length) }} />;
  }
  if (!href) return <>{children}</>;
  return (
    <a className="comment-link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * A comment body rendered as the markdown it was written in (GitHub-flavoured,
 * with single newlines as breaks), with the forge's references and mentions
 * resolved into chips.
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

  const markdown = useMemo(() => preprocessBody(body, status), [body, status]);
  const components = useMemo(
    () => ({ a: (props: { href?: string; children?: ReactNode }) => <BodyLink {...props} status={status} /> }),
    [status],
  );

  return (
    <div className="comment-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // Our own chip schemes must survive the default url sanitiser.
        urlTransform={(url) => (url.startsWith(REF_SCHEME) || url.startsWith(MENTION_SCHEME) ? url : defaultUrlTransform(url))}
        components={components}
      >
        {markdown}
      </Markdown>
    </div>
  );
}
