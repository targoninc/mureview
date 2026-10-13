import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AnchoredOverlay,
  Button,
  Checkbox,
  Flash,
  FormControl,
  Heading,
  IconButton,
  Select,
  Spinner,
  TextInput,
} from '@primer/react';
import { FilterIcon, LockIcon, PlusIcon, TrashIcon, XIcon } from '@primer/octicons-react';
import type { AvailableRepo, RepoSource, ReviewSetDetail, ReviewSetMode, ReviewSetRepo } from '../../shared/types';
import { ServiceIcon, serviceDetail } from '../components/ServiceIcon';
import { del, post, put, api } from '../lib/api';
import { useDetail } from '../lib/useDetail';

interface FormState {
  name: string;
  mode: ReviewSetMode;
  selected: ReviewSetRepo[];
  branchRegex: string;
  targetBranch: string;
}

const emptyForm: FormState = { name: '', mode: 'pattern', selected: [], branchRegex: '', targetBranch: 'main' };

type BranchList = { state: 'loading' } | { state: 'error' } | { state: 'ready'; branches: string[] };

export function ReviewSetFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const { detail, error: loadError } = useDetail(id);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [available, setAvailable] = useState<AvailableRepo[] | null>(null);
  const [sources, setSources] = useState<RepoSource[]>([]);
  const [repoErrors, setRepoErrors] = useState<{ connectionId: number; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [hiddenSources, setHiddenSources] = useState<Set<number>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [branches, setBranches] = useState<Record<string, BranchList>>({});

  const branchKey = (connectionId: number, repo: string) => `${connectionId}:${repo}`;

  const loadBranches = (connectionId: number, repo: string) => {
    const key = branchKey(connectionId, repo);
    setBranches((current) => (current[key] ? current : { ...current, [key]: { state: 'loading' } }));
    api<{ branches: string[] }>(`/repos/branches?connectionId=${connectionId}&repo=${encodeURIComponent(repo)}`)
      .then((result) => setBranches((current) => ({ ...current, [key]: { state: 'ready', branches: result.branches } })))
      .catch(() => setBranches((current) => ({ ...current, [key]: { state: 'error' } })));
  };

  useEffect(() => {
    if (form.mode !== 'per-repo') return;
    for (const item of form.selected) {
      if (!branches[branchKey(item.connectionId, item.repo)]) loadBranches(item.connectionId, item.repo);
    }
  }, [form.mode, form.selected]);

  useEffect(() => {
    api<{ repos: AvailableRepo[]; sources: RepoSource[]; errors: { connectionId: number; message: string }[] }>('/repos')
      .then((result) => {
        setAvailable(result.repos);
        setSources(result.sources);
        setRepoErrors(result.errors);
      })
      .catch((err: Error) => setRepoErrors([{ connectionId: 0, message: err.message }]));
  }, []);

  useEffect(() => {
    if (!detail) return;
    setForm({
      name: detail.reviewSet.name,
      mode: detail.reviewSet.mode,
      selected: detail.reviewSet.repos,
      branchRegex: detail.reviewSet.branchRegex,
      targetBranch: detail.reviewSet.targetBranch || 'main',
    });
  }, [detail]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  // Show the account/org on repositories whose host is served by more than one
  // connection (e.g. several Azure DevOps organizations).
  const ambiguousHosts = useMemo(() => {
    const hosts = new Map<string, number>();
    for (const source of sources) hosts.set(source.host, (hosts.get(source.host) ?? 0) + 1);
    return new Set([...hosts.entries()].filter(([, count]) => count > 1).map(([host]) => host));
  }, [sources]);

  const results = useMemo(() => {
    if (!available) return [];
    const needle = search.trim().toLowerCase();
    return available
      .filter((repo) => !hiddenSources.has(repo.connectionId))
      .filter((repo) => !form.selected.some((item) => item.connectionId === repo.connectionId && item.repo === repo.repo))
      .filter((repo) => !needle || `${repo.host}/${repo.repo}`.toLowerCase().includes(needle))
      .slice(0, 100);
  }, [available, form.selected, search, hiddenSources]);

  const addRepo = (repo: AvailableRepo) => {
    update({
      selected: [
        ...form.selected,
        { connectionId: repo.connectionId, repo: repo.repo, kind: repo.kind, host: repo.host, org: repo.org, branch: null, target: null },
      ],
    });
    setSearch('');
  };

  const addAllResults = () => {
    const additions = results.map((repo) => ({
      connectionId: repo.connectionId,
      repo: repo.repo,
      kind: repo.kind,
      host: repo.host,
      org: repo.org,
      branch: null,
      target: null,
    }));
    update({ selected: [...form.selected, ...additions] });
    setSearch('');
  };

  const toggleSource = (connectionId: number) => {
    setHiddenSources((current) => {
      const next = new Set(current);
      if (next.has(connectionId)) next.delete(connectionId);
      else next.add(connectionId);
      return next;
    });
  };

  const removeRepo = (connectionId: number, repo: string) => {
    update({ selected: form.selected.filter((item) => !(item.connectionId === connectionId && item.repo === repo)) });
  };

  const setRepoBranches = (connectionId: number, repo: string, patch: { branch?: string; target?: string }) => {
    update({
      selected: form.selected.map((item) =>
        item.connectionId === connectionId && item.repo === repo ? { ...item, ...patch } : item,
      ),
    });
  };

  const branchOptions = (item: ReviewSetRepo, value: string | null): string[] => {
    const list = branches[branchKey(item.connectionId, item.repo)];
    const known = list?.state === 'ready' ? list.branches : [];
    return value && !known.includes(value) ? [value, ...known] : known;
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      mode: form.mode,
      repos: form.selected.map((item) => ({
        connectionId: item.connectionId,
        repo: item.repo,
        branch: item.branch,
        target: item.target,
      })),
      branchRegex: form.branchRegex,
      targetBranch: form.targetBranch,
    };
    try {
      const result = editing
        ? await put<{ detail: ReviewSetDetail }>(`/review-sets/${id}`, body)
        : await post<{ detail: ReviewSetDetail }>('/review-sets', body);
      navigate(`/review-sets/${result.detail.reviewSet.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!id || !window.confirm('Delete this review set and its comments?')) return;
    try {
      await del(`/review-sets/${id}`);
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (editing && !detail && !loadError) {
    return (
      <div className="centered">
        <Spinner aria-label="Loading" />
      </div>
    );
  }

  const invalidErrors = detail?.pr.state === 'invalid' ? detail.pr.errors : [];

  return (
    <div className="page-scroll">
      <div className="page-inner" style={{ maxWidth: 760 }}>
        <Heading as="h1" variant="medium">
          {editing ? 'Review set settings' : 'New review set'}
        </Heading>
        {loadError ? <Flash variant="danger">{loadError}</Flash> : null}
        {error ? <Flash variant="danger">{error}</Flash> : null}
        {repoErrors.map((repoError) => (
          <Flash variant="warning" key={`${repoError.connectionId}:${repoError.message}`}>
            Could not list repositories — {repoError.message}
          </Flash>
        ))}
        {invalidErrors.length > 0 ? (
          <Flash variant="danger">
            <strong>Invalid configuration</strong>
            <ul className="error-list">
              {invalidErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Flash>
        ) : null}

        <FormControl>
          <FormControl.Label>Name</FormControl.Label>
          <TextInput block value={form.name} onChange={(event) => update({ name: event.target.value })} placeholder="Release 2.4" />
        </FormControl>

        <FormControl>
          <FormControl.Label>Repositories</FormControl.Label>
          <div className="repo-picker-search">
            <TextInput
              block
              leadingVisual={PlusIcon}
              placeholder="Filter repositories, e.g. targoninc/"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <AnchoredOverlay
              open={filterOpen}
              onOpen={() => setFilterOpen(true)}
              onClose={() => setFilterOpen(false)}
              width="auto"
              renderAnchor={(anchorProps) => (
                <IconButton
                  {...anchorProps}
                  icon={FilterIcon}
                  aria-label="Filter repositories by forge"
                  variant={hiddenSources.size > 0 ? 'primary' : 'default'}
                />
              )}
            >
              <div className="stack sources-menu" style={{ padding: 12, gap: 8 }}>
                <strong style={{ fontSize: 12 }}>Sources</strong>
                {sources.map((source) => (
                  <label key={source.connectionId} className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 12 }}>
                    <Checkbox checked={!hiddenSources.has(source.connectionId)} onChange={() => toggleSource(source.connectionId)} />
                    <ServiceIcon kind={source.kind} detail={serviceDetail(source.kind, source)} />
                    <span className="source-label">{source.label}</span>
                  </label>
                ))}
                {sources.length === 0 ? <span style={{ fontSize: 12 }}>No forges connected.</span> : null}
              </div>
            </AnchoredOverlay>
          </div>
          {available === null ? <Spinner size="small" aria-label="Loading repositories" /> : null}
          {available !== null && results.length > 0 ? (
            <>
              <div className="repo-picker-actions">
                <Button size="small" variant="invisible" onClick={addAllResults}>
                  Select all {results.length} shown
                </Button>
              </div>
              <div className="repo-picker-results">
                {results.map((repo) => (
                  <button
                    type="button"
                    className="repo-picker-item"
                    key={`${repo.connectionId}:${repo.repo}`}
                    onClick={() => addRepo(repo)}
                  >
                    <span className="mono">
                      {repo.host}/{repo.repo}
                    </span>
                    <span className="row" style={{ gap: 8 }}>
                      {ambiguousHosts.has(repo.host) ? <span className="repo-source">{repo.sourceLabel}</span> : null}
                      {repo.private ? (
                        <span
                          title="Private repository"
                          aria-label="Private repository"
                          style={{ display: 'inline-flex', color: 'var(--fgColor-muted)' }}
                        >
                          <LockIcon size={12} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {available !== null && results.length === 0 ? (
            <FormControl.Caption>
              {search ? `No repositories match "${search}".` : 'No repositories available. Connect a forge under Settings.'}
            </FormControl.Caption>
          ) : null}
        </FormControl>

        {form.selected.length > 0 ? (
          <div className="repo-picker-selected">
            {form.selected.map((item) => (
              <div className="repo-picker-selected-item" key={`${item.connectionId}:${item.repo}`}>
                <span className="mono">
                  {item.host}/{item.repo}
                </span>
                <span className="row" style={{ gap: 8 }}>
                  {form.mode === 'per-repo' ? (
                    <>
                      <Select
                        size="small"
                        aria-label={`Source branch for ${item.repo}`}
                        value={item.branch ?? ''}
                        onChange={(event) => setRepoBranches(item.connectionId, item.repo, { branch: event.target.value })}
                      >
                        <Select.Option value="">Source branch…</Select.Option>
                        {branchOptions(item, item.branch).map((branch) => (
                          <Select.Option key={branch} value={branch}>
                            {branch}
                          </Select.Option>
                        ))}
                      </Select>
                      <Select
                        size="small"
                        aria-label={`Target branch for ${item.repo}`}
                        value={item.target ?? ''}
                        onChange={(event) => setRepoBranches(item.connectionId, item.repo, { target: event.target.value })}
                      >
                        <Select.Option value="">Target branch…</Select.Option>
                        {branchOptions(item, item.target).map((branch) => (
                          <Select.Option key={branch} value={branch}>
                            {branch}
                          </Select.Option>
                        ))}
                      </Select>
                    </>
                  ) : null}
                  {ambiguousHosts.has(item.host) ? (
                    <span className="repo-source">{sources.find((source) => source.connectionId === item.connectionId)?.label}</span>
                  ) : null}
                  <ServiceIcon kind={item.kind} detail={serviceDetail(item.kind, item)} />
                  <Button
                    size="small"
                    variant="danger"
                    leadingVisual={XIcon}
                    aria-label={`Remove ${item.repo}`}
                    onClick={() => removeRepo(item.connectionId, item.repo)}
                  />
                </span>
              </div>
            ))}
          </div>
        ) : (
          <FormControl.Caption>No repositories selected yet.</FormControl.Caption>
        )}

        <FormControl>
          <FormControl.Label>Branches</FormControl.Label>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <Button
              size="small"
              variant={form.mode === 'pattern' ? 'primary' : 'invisible'}
              onClick={() => update({ mode: 'pattern' })}
            >
              Pattern-based
            </Button>
            <Button
              size="small"
              variant={form.mode === 'per-repo' ? 'primary' : 'invisible'}
              onClick={() => update({ mode: 'per-repo' })}
            >
              Per-repo
            </Button>
          </div>
          {form.mode === 'pattern' ? (
            <>
              <FormControl.Caption>
                One or more regular expressions separated by commas, for example ^main$, ^release/v2\.\d+. Across all patterns
                each repository must match at most one branch.
              </FormControl.Caption>
              <TextInput
                block
                value={form.branchRegex}
                onChange={(event) => update({ branchRegex: event.target.value })}
                placeholder="^main$, ^release/v2\\.\\d+"
              />
            </>
          ) : (
            <FormControl.Caption>
              Pick a source and target branch for every repository above. Repositories without a source branch are skipped.
            </FormControl.Caption>
          )}
        </FormControl>

        {form.mode === 'pattern' ? (
          <FormControl>
            <FormControl.Label>Target branch</FormControl.Label>
            <FormControl.Caption>
              The branch your matched branches are compared against. It is created for repositories where it does not exist yet.
            </FormControl.Caption>
            <TextInput block value={form.targetBranch} onChange={(event) => update({ targetBranch: event.target.value })} />
          </FormControl>
        ) : null}

        <div className="form-actions">
          {editing ? (
            <Button variant="danger" leadingVisual={TrashIcon} onClick={remove}>
              Delete
            </Button>
          ) : null}
          <Button onClick={() => navigate(editing ? `/review-sets/${id}` : '/')}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={saving || form.selected.length === 0}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create review set'}
          </Button>
        </div>
      </div>
    </div>
  );
}
