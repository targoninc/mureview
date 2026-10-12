import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Flash, Heading, Label, Spinner } from '@primer/react';
import { GitMergeIcon } from '@primer/octicons-react';
import type { MergePreview, MergePreviewRepo, MergeResult, ReviewSetDetail } from '../../shared/types';
import { api, post } from '../lib/api';
import { MergeResultsFlash } from '../components/pr/merge';

type ConflictTone = 'success' | 'danger' | 'attention' | 'secondary';

function conflictBadge(repo: MergePreviewRepo): { text: string; tone: ConflictTone } {
  if (repo.error) return { text: repo.error, tone: 'danger' };
  if (repo.conflicts === 'detected') {
    return { text: `${repo.conflictFiles.length} conflicting ${repo.conflictFiles.length === 1 ? 'file' : 'files'}`, tone: 'danger' };
  }
  if (repo.conflicts === 'unknown') return { text: 'conflicts could not be checked', tone: 'attention' };
  if (!repo.targetExists) return { text: `creates ${repo.target}`, tone: 'secondary' };
  return { text: 'no conflicts', tone: 'success' };
}

function RepoCard({ repo }: { repo: MergePreviewRepo }) {
  const badge = conflictBadge(repo);
  const kindLabel = repo.kind === 'github' ? '' : repo.kind === 'ado' ? 'azure devops · ' : `${repo.kind} · `;
  return (
    <div className="merge-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="mono">
            {kindLabel}
            {repo.host}/{repo.repo}
          </span>
          <span className="mono" style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
            {repo.branch} → {repo.target}
          </span>
        </div>
        <Label variant={badge.tone}>{badge.text}</Label>
      </div>
      <div className="repo-list-meta" style={{ marginTop: 8 }}>
        <span>
          {repo.files} {repo.files === 1 ? 'file' : 'files'}
        </span>
        <span className="additions">+{repo.additions}</span>
        <span className="deletions">−{repo.deletions}</span>
        {repo.aheadBy > 0 ? <span>{repo.aheadBy} commits ahead</span> : null}
        {repo.behindBy > 0 ? <span>{repo.behindBy} commits behind</span> : null}
        {repo.uncheckedFiles > 0 ? <span>{repo.uncheckedFiles} files not checked</span> : null}
      </div>
      {repo.conflictFiles.length > 0 ? (
        <div className="merge-conflicts">
          {repo.conflictFiles.map((path) => (
            <span className="mono" key={path}>
              {path}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function MergePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [results, setResults] = useState<MergeResult[] | null>(null);

  useEffect(() => {
    if (!id) return;
    api<MergePreview>(`/review-sets/${id}/merge`)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  }, [id]);

  const runMerge = async () => {
    setMerging(true);
    setError(null);
    try {
      const result = await post<{ results: MergeResult[]; detail: ReviewSetDetail }>(`/review-sets/${id}/merge`, {});
      setResults(result.results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMerging(false);
    }
  };

  if (error && !preview) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <Flash variant="danger">{error}</Flash>
        </div>
      </div>
    );
  }

  if (!preview) {
    return (
      <div className="centered">
        <Spinner size="large" aria-label="Checking merge" />
      </div>
    );
  }

  const conflictCount = preview.repos.filter((repo) => repo.conflicts === 'detected').length;

  return (
    <div className="page-scroll">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <Heading as="h1" variant="medium">
          Merge into <span className="mono">{preview.target}</span>
        </Heading>
        <p style={{ margin: 0, color: 'var(--fgColor-muted)' }}>
          {results
            ? 'The merge finished. Review the per-repository results below.'
            : `${preview.repos.length} ${preview.repos.length === 1 ? 'branch' : 'branches'} will be merged on their forges. Conflicts are checked before merging.`}
        </p>

        {error ? <Flash variant="danger">{error}</Flash> : null}
        {results ? <MergeResultsFlash results={results} /> : null}
        {conflictCount > 0 && !results ? (
          <Flash variant="danger">
            <strong>
              {conflictCount} {conflictCount === 1 ? 'repository has' : 'repositories have'} merge conflicts.
            </strong>{' '}
            Resolve them on the forge (or retarget the branch pattern) before merging.
          </Flash>
        ) : null}

        {preview.repos.map((repo) => (
          <RepoCard key={`${repo.connectionId}:${repo.repo}`} repo={repo} />
        ))}

        <div className="form-actions">
          <Button onClick={() => navigate(`/review-sets/${id}`)}>{results ? 'Back to review set' : 'Cancel'}</Button>
          {results ? null : (
            <Button variant="primary" leadingVisual={GitMergeIcon} disabled={!preview.canMerge || merging} onClick={runMerge}>
              {merging ? 'Merging…' : `Merge ${preview.repos.length} ${preview.repos.length === 1 ? 'branch' : 'branches'}`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
