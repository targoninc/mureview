import { Flash } from '@primer/react';
import type { MergeResult } from '../../../shared/types';

export function MergeResultsFlash({ results }: { results: MergeResult[] }) {
  const failed = results.filter((result) => !result.ok);
  const variant = failed.length === 0 ? 'success' : failed.length === results.length ? 'danger' : 'warning';
  return (
    <Flash variant={variant}>
      <strong>{failed.length === 0 ? 'Merge complete' : failed.length === results.length ? 'Merge failed' : 'Merge partially complete'}</strong>
      <ul className="error-list">
        {results.map((result) => (
          <li key={`${result.label}:${result.message}`}>
            {result.label ? <span className="mono">{result.label}: </span> : null}
            {result.message}
          </li>
        ))}
      </ul>
    </Flash>
  );
}
