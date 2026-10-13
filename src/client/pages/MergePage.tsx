import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Dialog, Flash, Heading, Label, Spinner } from '@primer/react';
import { CheckCircleFillIcon, ClockIcon, GitMergeIcon, GitPullRequestIcon, XCircleFillIcon } from '@primer/octicons-react';
import type {
  ForgeKind,
  MergePreviewRepo,
  MergeResult,
  RepoStatus,
  ReviewSetDetail,
  ReviewSetRepo,
} from '../../shared/types';
import { post } from '../lib/api';
import { checkTone } from '../lib/checks';
import { streamJson } from '../lib/ndjson';
import { repoStatusText } from '../lib/format';
import { MergeResultsFlash } from '../components/pr/merge';
import { ReviewSetLoading } from '../components/pr/ReviewSetLoading';
import { ServiceIcon, serviceDetail } from '../components/ServiceIcon';

type ConflictTone = 'success' | 'danger' | 'attention' | 'secondary';

type MergeEvent =
  | { target: string; repos: ReviewSetRepo[] }
  | { status: RepoStatus }
  | { checking: number }
  | { repo: MergePreviewRepo }
  | { done: { canMerge: boolean } }
  | { error: string };

interface RepoCardInfo {
  connectionId: number;
  kind: ForgeKind;
  host: string;
  org: string | null;
  repo: string;
  status?: RepoStatus;
  preview?: MergePreviewRepo;
}

function cardKey(connectionId: number, repo: string): string {
  return `${connectionId}:${repo}`;
}

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
          {repo.canComplete === 'no' ? <Label variant="attention">no permission</Label> : null}
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

function MergeCard({ card }: { card: RepoCardInfo }) {
  if (card.preview) return <RepoCard repo={card.preview} />;
  const status = card.status;
  return (
    <div className="merge-card">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4 }}>
          <span className="row" style={{ gap: 6 }}>
            <ServiceIcon kind={card.kind} detail={serviceDetail(card.kind, card)} />
            <span className="mono">
              {card.host}/{card.repo}
            </span>
          </span>
          {status?.branch ? (
            <span className="mono" style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>
              {status.branch}
            </span>
          ) : null}
        </div>
        {status && status.state !== 'open' ? (
          <Label variant={status.state === 'error' ? 'danger' : 'secondary'}>{repoStatusText(status)}</Label>
        ) : null}
      </div>
      {status && status.state !== 'open' ? (
        status.error ? (
          <span className="load-meta" title={status.error}>
            {status.error}
          </span>
        ) : null
      ) : (
        <span className="load-meta row" style={{ gap: 6, marginTop: 8 }}>
          <Spinner size="small" aria-label="Checking repository" />
          {status ? 'checking conflicts and checks…' : 'checking branches…'}
        </span>
      )}
    </div>
  );
}

export function MergePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  const [cards, setCards] = useState<RepoCardInfo[]>([]);
  const [statusLoaded, setStatusLoaded] = useState(0);
  const [mergesLoaded, setMergesLoaded] = useState(0);
  const [openTotal, setOpenTotal] = useState(0);
  const [canMerge, setCanMerge] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [results, setResults] = useState<MergeResult[] | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);

  // The stream sends the target branch and every repository first, then each
  // repository's status as its branch is inspected, then the preview cards
  // (conflicts, checks, diffs) one by one.
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setTarget('');
    setCards([]);
    setStatusLoaded(0);
    setMergesLoaded(0);
    setOpenTotal(0);
    setCanMerge(false);
    setReady(false);
    setError(null);

    const patch = (key: string, update: (card: RepoCardInfo) => RepoCardInfo) =>
      setCards((current) => current.map((card) => (cardKey(card.connectionId, card.repo) === key ? update(card) : card)));

    const handle = (event: MergeEvent) => {
      if ('target' in event) {
        setTarget(event.target);
        setCards(
          event.repos.map((repo) => ({
            connectionId: repo.connectionId,
            kind: repo.kind,
            host: repo.host,
            org: repo.org,
            repo: repo.repo,
          })),
        );
      } else if ('status' in event) {
        const key = cardKey(event.status.connectionId, event.status.repo);
        patch(key, (card) => ({ ...card, status: event.status }));
        setStatusLoaded((current) => current + 1);
      } else if ('checking' in event) {
        setOpenTotal(event.checking);
      } else if ('repo' in event) {
        const key = cardKey(event.repo.connectionId, event.repo.repo);
        patch(key, (card) => ({ ...card, preview: event.repo }));
        setMergesLoaded((current) => current + 1);
      } else if ('done' in event) {
        setCanMerge(event.done.canMerge);
        setReady(true);
      } else if ('error' in event) {
        setError(event.error);
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

  const started = cards.length > 0 || ready;

  if (error && !started) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <Flash variant="danger">{error}</Flash>
        </div>
      </div>
    );
  }

  if (!started) {
    return <ReviewSetLoading id={id} title="Checking what would be merged…" />;
  }

  const previews = cards.map((card) => card.preview).filter((entry): entry is MergePreviewRepo => Boolean(entry));
  const runs = previews.flatMap((repo) => repo.checks.runs);
  const failing = runs.filter((run) => run.state === 'failure').length;
  const pending = runs.filter((run) => run.state === 'pending' || run.state === 'unknown').length;
  const passing = runs.length - failing - pending;
  const checksState = failing > 0 ? 'failure' : pending > 0 ? 'pending' : runs.length > 0 ? 'success' : 'none';
  const conflictCount = previews.filter((repo) => repo.conflicts === 'detected').length;
  const blockedCount = previews.filter((repo) => repo.canComplete === 'no').length;
  const checksLabel =
    checksState === 'failure'
      ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
      : checksState === 'pending'
        ? `${passing}/${runs.length} checks passed, ${pending} running`
        : `${passing}/${runs.length} checks passed`;
  const ChecksIcon = checksState === 'failure' ? XCircleFillIcon : checksState === 'pending' ? ClockIcon : CheckCircleFillIcon;

  const progress =
    statusLoaded < cards.length
      ? { text: `Checking repositories ${statusLoaded}/${cards.length}`, done: statusLoaded, total: cards.length }
      : !ready && mergesLoaded < openTotal
        ? { text: `Checking merges ${mergesLoaded}/${openTotal}`, done: mergesLoaded, total: openTotal }
        : null;

  return (
    <div className="page-scroll">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <Heading as="h1" variant="medium">
          {target ? (
            <>
              Merge into <span className="mono">{target}</span>
            </>
          ) : (
            'Merge branches'
          )}
        </Heading>
        {ready ? (
          <p style={{ margin: 0, color: 'var(--fgColor-muted)' }}>
            {results
              ? 'The merge finished. Review the per-repository results below.'
              : openTotal === 0
                ? 'Nothing to merge: no matched branch has changes against the target branch.'
                : `${openTotal} ${openTotal === 1 ? 'branch' : 'branches'} will be merged through one pull request per repository. Conflicts and checks are evaluated before merging.`}
          </p>
        ) : null}

        {progress ? (
          <p className="row" style={{ gap: 6, margin: 0, color: 'var(--fgColor-muted)', fontSize: 12 }}>
            <Spinner size="small" aria-label={progress.text} />
            {progress.text}
            <span
              className="mini-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={progress.done}
            >
              <span
                className="mini-progress-fill"
                style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
              />
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
        {blockedCount > 0 && !results ? (
          <Flash variant="danger">
            <strong>
              You cannot complete pull requests in {blockedCount} {blockedCount === 1 ? 'repository' : 'repositories'}.
            </strong>{' '}
            Ask someone with write access to merge, or merge manually on the forge.
          </Flash>
        ) : null}

        {cards.map((card) => (
          <MergeCard key={cardKey(card.connectionId, card.repo)} card={card} />
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
              <Button variant="primary" leadingVisual={GitMergeIcon} disabled={!ready || !canMerge || merging} onClick={runMerge}>
                {!ready ? 'Checking…' : merging ? 'Merging…' : `Merge ${openTotal} ${openTotal === 1 ? 'branch' : 'branches'}`}
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
            {previews.map((repo) => (
              <div className="stack" style={{ gap: 8 }} key={cardKey(repo.connectionId, repo.repo)}>
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
