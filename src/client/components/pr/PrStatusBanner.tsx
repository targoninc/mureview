import { Flash } from '@primer/react';
import type { PrStatus, ReviewSet } from '../../../shared/types';

function ErrorList({ errors }: { errors: string[] }) {
  return (
    <ul className="error-list">
      {errors.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

export function PrStatusBanner({ pr, reviewSet }: { pr: PrStatus; reviewSet: ReviewSet }) {
  if (pr.state === 'open') {
    return pr.errors.length > 0 ? (
      <Flash variant="warning">
        <strong>Some repositories could not be processed</strong>
        <ErrorList errors={pr.errors} />
      </Flash>
    ) : null;
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
        <strong>All matched branches are merged into {reviewSet.targetBranch}.</strong> The ephemeral pull request was closed and
        its comments were discarded. Configure a new branch pattern or point at new branches to start the next review.
        {merged.length > 0 ? (
          <div style={{ marginTop: 4 }}>
            {merged.map((repo) => `${repo.repo}: ${repo.branch}`).join(' · ')}
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
