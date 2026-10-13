import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, Flash, Heading, Label, Spinner } from '@primer/react';
import { CheckCircleFillIcon, ClockIcon, GitMergeIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { CheckInfo, MergePreview, MergePreviewRepo, MergeResult, ReviewSetDetail } from '../../shared/types';
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

const checkTone: Record<CheckInfo['state'], 'success' | 'danger' | 'attention' | 'secondary'> = {
  success: 'success',
  failure: 'danger',
  pending: 'attention',
  neutral: 'secondary',
  skipped: 'secondary',
  unknown: 'attention',
};

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
          {repo.pullRequest ? (
            <a className="forge-link" href={repo.pullRequest.url} target="_blank" rel="noreferrer">
              Pull request #{repo.pullRequest.number}
            </a>
          ) : null}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {repo.checks.state === 'failure' ? <Label variant="danger">checks failing</Label> : null}
          <Label variant={badge.tone}>{badge.text}</Label>
        </div>
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
  const [checksOpen, setChecksOpen] = useState(false);

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

  const runs = preview.repos.flatMap((repo) => repo.checks.runs);
  const failing = runs.filter((run) => run.state === 'failure').length;
  const pending = runs.filter((run) => run.state === 'pending' || run.state === 'unknown').length;
  const passing = runs.length - failing - pending;
  const checksState = failing > 0 ? 'failure' : pending > 0 ? 'pending' : runs.length > 0 ? 'success' : 'none';
  const conflictCount = preview.repos.filter((repo) => repo.conflicts === 'detected').length;
  const checksLabel =
    checksState === 'failure'
      ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
      : checksState === 'pending'
        ? `${passing}/${runs.length} checks passed, ${pending} running`
        : `${passing}/${runs.length} checks passed`;
  const ChecksIcon = checksState === 'failure' ? XCircleFillIcon : checksState === 'pending' ? ClockIcon : CheckCircleFillIcon;

  return (
    <div className="page-scroll">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <Heading as="h1" variant="medium">
          Merge into <span className="mono">{preview.target}</span>
        </Heading>
        <p style={{ margin: 0, color: 'var(--fgColor-muted)' }}>
          {results
            ? 'The merge finished. Review the per-repository results below.'
            : `${preview.repos.length} ${preview.repos.length === 1 ? 'branch' : 'branches'} will be merged through one pull request per repository. Conflicts and checks are evaluated before merging.`}
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
        {checksState === 'failure' && !results ? (
          <Flash variant="danger">
            <strong>Pre-merge checks are failing.</strong> Fix or re-run them, or merge manually on the forge.
          </Flash>
        ) : null}

        {preview.repos.map((repo) => (
          <RepoCard key={`${repo.connectionId}:${repo.repo}`} repo={repo} />
        ))}

        <div className="form-actions">
          <Button onClick={() => navigate(`/review-sets/${id}`)}>{results ? 'Back to review set' : 'Cancel'}</Button>
          <div className="row" style={{ gap: 8 }}>
            {runs.length > 0 ? (
              <Button
                variant="invisible"
                leadingVisual={<ChecksIcon className={`checks-${checksState}`} />}
                onClick={() => setChecksOpen(true)}
              >
                {checksLabel}
              </Button>
            ) : null}
            {results ? null : (
              <Button variant="primary" leadingVisual={GitMergeIcon} disabled={!preview.canMerge || merging} onClick={runMerge}>
                {merging ? 'Merging…' : `Merge ${preview.repos.length} ${preview.repos.length === 1 ? 'branch' : 'branches'}`}
              </Button>
            )}
          </div>
        </div>
      </div>

      {checksOpen ? (
        <Dialog
          title="Pre-merge checks"
          width="large"
          onClose={() => setChecksOpen(false)}
          footerButtons={[{ content: 'Close', onClick: () => setChecksOpen(false), buttonType: 'default' }]}
        >
          <div className="stack" style={{ gap: 20 }}>
            {preview.repos.map((repo) => (
              <div className="stack" style={{ gap: 8 }} key={`${repo.connectionId}:${repo.repo}`}>
                <strong className="mono" style={{ fontSize: 12 }}>
                  {repo.host}/{repo.repo} · {repo.branch}
                </strong>
                {repo.checks.runs.length === 0 ? (
                  <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>No checks reported for this branch.</span>
                ) : (
                  repo.checks.runs.map((run) => (
                    <div className="check-row" key={run.name}>
                      <span className={`check-dot checks-${run.state}`} />
                      <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13 }}>{run.name}</span>
                        {run.description ? <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>{run.description}</span> : null}
                      </div>
                      {run.url ? (
                        <Button as="a" href={run.url} target="_blank" rel="noreferrer" size="small" variant="invisible">
                          Details
                        </Button>
                      ) : null}
                      <Label variant={checkTone[run.state]}>{run.state}</Label>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
