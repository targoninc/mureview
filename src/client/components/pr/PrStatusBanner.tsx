import { useState } from 'react';
import { Button, Flash } from '@primer/react';
import type { PrStatus, ReviewSet } from '../../../shared/types';
import { repoLabel } from '../../../shared/types';
import { basePath } from '../../lib/api';
import { useAppContext } from '../../lib/appContext';

/** Long lists of messages are collapsed so they don't push the diff out of view. */
function MessageList({ messages }: { messages: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? messages : messages.slice(0, 1);
  return (
    <>
      <ul className="error-list">
        {shown.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      {messages.length > shown.length ? (
        <Button size="small" variant="invisible" onClick={() => setExpanded(true)}>
          Show {messages.length - shown.length} more
        </Button>
      ) : null}
    </>
  );
}

function AccessHint() {
  const { githubOAuthAppUrl } = useAppContext();
  const oauthAppUrl = githubOAuthAppUrl;
  if (!oauthAppUrl) return null;
  return (
    <p style={{ margin: '8px 0 0' }}>
      Missing access to a repository that belongs to an organization?{' '}
      <a href={oauthAppUrl} target="_blank" rel="noreferrer">
        Grant the GitHub app access to it
      </a>{' '}
      and refresh.
    </p>
  );
}

function ErrorList({ errors }: { errors: string[] }) {
  return (
    <>
      <MessageList messages={errors} />
      <AccessHint />
    </>
  );
}

export function PrStatusBanner({ pr, reviewSet }: { pr: PrStatus; reviewSet: ReviewSet }) {
  if (pr.state === 'loading') return null;

  // Notes explain collapsed or out-of-order stack layers; they are not errors.
  const notes = pr.repos
    .filter((repo) => repo.note)
    .map((repo) => `${repoLabel(repo)}${repo.branch ? ` (${repo.branch})` : ''}: ${repo.note}`);
  const notesBanner =
    notes.length > 0 ? (
      <Flash variant="warning">
        <strong>Stack notes</strong>
        <MessageList messages={notes} />
      </Flash>
    ) : null;

  // Comments and merging need a real pull request per branch; when creating
  // one fails the review still works, but the reason must be visible.
  const prErrors = pr.repos
    .filter((repo) => repo.prError)
    .map((repo) => `${repoLabel(repo)}${repo.branch ? ` (${repo.branch})` : ''}: ${repo.prError}`);
  const prErrorsBanner =
    prErrors.length > 0 ? (
      <Flash variant="warning">
        <strong>No forge pull request yet</strong>
        <MessageList messages={prErrors} />
        {prErrors.some((message) => /atproto/i.test(message)) ? (
          <p style={{ margin: '8px 0 0' }}>
            <a href={`${basePath}/settings`}>Open settings</a> to sign in with atproto, then reload this review set.
          </p>
        ) : null}
      </Flash>
    ) : null;

  if (pr.state === 'open') {
    return (
      <>
        {prErrorsBanner}
        {notesBanner}
        {pr.errors.length > 0 ? (
          <Flash variant="warning">
            <strong>Some repositories could not be processed</strong>
            <ErrorList errors={pr.errors} />
          </Flash>
        ) : null}
      </>
    );
  }

  if (pr.state === 'invalid') {
    return (
      <Flash variant="danger">
        <strong>Invalid configuration</strong>
        <ErrorList errors={pr.errors} />
      </Flash>
    );
  }

  // Everything merged: the header says so, no banner needed.
  if (pr.state === 'closed') return null;

  return (
    <Flash variant={pr.errors.length ? 'danger' : 'default'}>
      {pr.errors.length ? (
        <>
          <strong>Nothing to review</strong>
          <ErrorList errors={pr.errors} />
        </>
      ) : (
        <>
          <strong>No matching branches.</strong> The branch pattern matched nothing in the configured repositories, so there is no
          pull request to show.
        </>
      )}
    </Flash>
  );
}
