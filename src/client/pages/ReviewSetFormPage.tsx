import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnchoredOverlay, Button, Checkbox, Flash, FormControl, Heading, IconButton, Label, Spinner, TextInput } from '@primer/react';
import { FilterIcon, PlusIcon, TrashIcon, XIcon } from '@primer/octicons-react';
import type { AvailableRepo, ReviewSetDetail, ReviewSetRepo } from '../../shared/types';
import { del, post, put, api } from '../lib/api';
import { useDetail } from '../lib/useDetail';

interface FormState {
  name: string;
  selected: ReviewSetRepo[];
  branchRegex: string;
  targetBranch: string;
}

const emptyForm: FormState = { name: '', selected: [], branchRegex: '', targetBranch: 'main' };

export function ReviewSetFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const { detail, error: loadError } = useDetail(id);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [available, setAvailable] = useState<AvailableRepo[] | null>(null);
  const [repoErrors, setRepoErrors] = useState<{ connectionId: number; message: string }[]>([]);
  const [search, setSearch] = useState('');
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());
  const [filterOpen, setFilterOpen] = useState(false);

  useEffect(() => {
    api<{ repos: AvailableRepo[]; errors: { connectionId: number; message: string }[] }>('/repos')
      .then((result) => {
        setAvailable(result.repos);
        setRepoErrors(result.errors);
      })
      .catch((err: Error) => setRepoErrors([{ connectionId: 0, message: err.message }]));
  }, []);

  useEffect(() => {
    if (!detail) return;
    setForm({
      name: detail.reviewSet.name,
      selected: detail.reviewSet.repos,
      branchRegex: detail.reviewSet.branchRegex,
      targetBranch: detail.reviewSet.targetBranch,
    });
  }, [detail]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const sources = useMemo(() => {
    if (!available) return [];
    const unique = new Map<string, { key: string; label: string }>();
    for (const repo of available) {
      const key = `${repo.kind}:${repo.host}`;
      if (!unique.has(key)) {
        const kindLabel = repo.kind === 'github' ? '' : repo.kind === 'ado' ? 'azure devops · ' : `${repo.kind} · `;
        unique.set(key, { key, label: `${kindLabel}${repo.host}` });
      }
    }
    return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [available]);

  const results = useMemo(() => {
    if (!available) return [];
    const needle = search.trim().toLowerCase();
    return available
      .filter((repo) => !hiddenSources.has(`${repo.kind}:${repo.host}`))
      .filter((repo) => !form.selected.some((item) => item.connectionId === repo.connectionId && item.repo === repo.repo))
      .filter((repo) => !needle || `${repo.host}/${repo.repo}`.toLowerCase().includes(needle))
      .slice(0, 100);
  }, [available, form.selected, search, hiddenSources]);

  const addRepo = (repo: AvailableRepo) => {
    update({ selected: [...form.selected, { connectionId: repo.connectionId, repo: repo.repo, kind: repo.kind, host: repo.host }] });
    setSearch('');
  };

  const addAllResults = () => {
    const additions = results.map((repo) => ({ connectionId: repo.connectionId, repo: repo.repo, kind: repo.kind, host: repo.host }));
    update({ selected: [...form.selected, ...additions] });
    setSearch('');
  };

  const toggleSource = (key: string) => {
    setHiddenSources((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeRepo = (connectionId: number, repo: string) => {
    update({ selected: form.selected.filter((item) => !(item.connectionId === connectionId && item.repo === repo)) });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      repos: form.selected.map((item) => ({ connectionId: item.connectionId, repo: item.repo })),
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
            Could not list repositories for {repoError.message}. Check the connection under Settings, or refresh in a few minutes if the
            forge is rate limiting.
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
              width="medium"
              renderAnchor={(anchorProps) => (
                <IconButton
                  {...anchorProps}
                  icon={FilterIcon}
                  aria-label="Filter repositories by forge"
                  variant={hiddenSources.size > 0 ? 'primary' : 'default'}
                />
              )}
            >
              <div className="stack" style={{ padding: 12, gap: 8 }}>
                <strong style={{ fontSize: 12 }}>Sources</strong>
                {sources.map((source) => (
                  <label key={source.key} className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 12 }}>
                    <Checkbox checked={!hiddenSources.has(source.key)} onChange={() => toggleSource(source.key)} />
                    {source.label}
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
                    {repo.private ? <Label variant="secondary">private</Label> : null}
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
                <span className="row">
                  <Label variant="secondary">{item.kind}</Label>
                  <Button
                    size="small"
                    variant="invisible"
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
          <FormControl.Label>Branch pattern</FormControl.Label>
          <FormControl.Caption>
            One or more regular expressions separated by commas, for example ^main$, ^release/v2\.\d+. Across all patterns each
            repository must match at most one branch.
          </FormControl.Caption>
          <TextInput
            block
            value={form.branchRegex}
            onChange={(event) => update({ branchRegex: event.target.value })}
            placeholder="^main$, ^release/v2\\.\\d+"
          />
        </FormControl>

        <FormControl>
          <FormControl.Label>Target branch</FormControl.Label>
          <FormControl.Caption>
            The branch your matched branches are compared against. It is created for repositories where it does not exist yet.
          </FormControl.Caption>
          <TextInput block value={form.targetBranch} onChange={(event) => update({ targetBranch: event.target.value })} />
        </FormControl>

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
