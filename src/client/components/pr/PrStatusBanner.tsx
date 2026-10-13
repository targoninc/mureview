import { Flash } from '@primer/react';
import type { PrStatus, ReviewSet } from '../../../shared/types';
import { useAppContext } from '../../lib/appContext';

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
      <ul className="error-list">
        {errors.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <AccessHint />
    </>
  );
}

export function PrStatusBanner({ pr, reviewSet }: { pr: PrStatus; reviewSet: ReviewSet }) {
  if (pr.state === 'loading') return null;

  // Notes explain collapsed or out-of-order stack layers; they are not errors.
  const notes = pr.repos
    .filter((repo) => repo.note)
    .map((repo) => `${repo.host}/${repo.repo}${repo.branch ? ` (${repo.branch})` : ''}: ${repo.note}`);
  const notesBanner =
    notes.length > 0 ? (
      <Flash variant="warning">
        <strong>Stack notes</strong>
        <ul className="error-list">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Flash>
    ) : null;

  if (pr.state === 'open') {
    return (
      <>
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

  if (pr.state === 'closed') {
    const merged = pr.repos.filter((repo) => repo.branch);
    return (
      <Flash variant="success">
        <strong>
          {reviewSet.mode === 'stack'
            ? 'Every stack was merged bottom-up.'
            : reviewSet.mode === 'per-repo'
              ? 'All matched branches are merged into their target branches.'
              : `All matched branches are merged into ${reviewSet.targetBranch}.`}
        </strong>{' '}
        The ephemeral pull request was closed and
        its comments were discarded. Configure a new branch pattern or point at new branches to start the next review.
        {merged.length > 0 ? (
          <div style={{ marginTop: 4 }}>
            {merged.map((repo) => `${repo.host}/${repo.repo}: ${repo.branch}`).join(' · ')}
          </div>
        ) : null}
      </Flash>
    );
  }

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
