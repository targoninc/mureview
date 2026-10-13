import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, Flash, Heading, Label, Spinner } from '@primer/react';
import { CheckCircleFillIcon, ClockIcon, GitMergeIcon, GitPullRequestIcon, XCircleFillIcon } from '@primer/octicons-react';
import type { CheckInfo, MergePreview, MergePreviewRepo, MergeResult, ReviewSetDetail } from '../../shared/types';
import { post } from '../lib/api';
import { streamJson } from '../lib/ndjson';
import { MergeResultsFlash } from '../components/pr/merge';
import { ReviewSetLoading } from '../components/pr/ReviewSetLoading';
import { ServiceIcon, serviceDetail } from '../components/ServiceIcon';

type ConflictTone = 'success' | 'danger' | 'attention' | 'secondary';

type MergeEvent =
  | { target: string }
  | { total: number }
  | { repo: MergePreviewRepo }
  | { done: { canMerge: boolean } }
  | { error: string };

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
  return (
    <div className="merge-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="row" style={{ gap: 6 }}>
            <ServiceIcon kind={repo.kind} detail={serviceDetail(repo.kind, repo)} />
            <span className="mono">
              {repo.host}/{repo.repo}
            </span>
          </span>
          <span className="mono" style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
            {repo.branch} → {repo.target}
          </span>
          {repo.pullRequest ? (
            <Button
              as="a"
              href={repo.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              size="small"
              leadingVisual={GitPullRequestIcon}
              style={{ alignSelf: 'flex-start' }}
            >
              PR #{repo.pullRequest.number}
            </Button>
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
  const [checking, setChecking] = useState<{ loaded: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [results, setResults] = useState<MergeResult[] | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);

  // The preview streams in: the target branch first, one card per repository
  // as it is checked, then whether everything can be merged.
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let target = '';
    let total = 0;
    const cards: MergePreviewRepo[] = [];
    setPreview(null);
    setChecking(null);
    setError(null);

    const handle = (event: MergeEvent) => {
      if ('target' in event) target = event.target;
      else if ('total' in event) {
        total = event.total;
        setChecking({ loaded: 0, total });
      } else if ('repo' in event) {
        cards.push(event.repo);
        setChecking({ loaded: cards.length, total });
        setPreview({ target, repos: [...cards], canMerge: false });
      } else if ('done' in event) {
        setPreview({ target, repos: [...cards], canMerge: event.done.canMerge });
        setChecking(null);
      } else if ('error' in event) {
        setError(event.error);
        setChecking(null);
      }
    };

    streamJson<MergeEvent>(`/review-sets/${id}/merge`, handle, controller.signal).catch((err: Error) => {
      if (err.name !== 'AbortError') setError(err.message);
    });
    return () => controller.abort();
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
    return <ReviewSetLoading id={id} title="Checking what would be merged…" />;
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

        {checking && checking.loaded < checking.total ? (
          <p className="row" style={{ gap: 6, margin: 0, color: 'var(--fgColor-muted)', fontSize: 12 }}>
            <Spinner size="small" aria-label="Checking repositories" />
            Checking repository {checking.loaded + 1}/{checking.total}
            <span
              className="mini-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={checking.total}
              aria-valuenow={checking.loaded}
            >
              <span className="mini-progress-fill" style={{ width: `${Math.round((checking.loaded / checking.total) * 100)}%` }} />
            </span>
          </p>
        ) : null}

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
                {checking ? 'Checking…' : merging ? 'Merging…' : `Merge ${preview.repos.length} ${preview.repos.length === 1 ? 'branch' : 'branches'}`}
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
