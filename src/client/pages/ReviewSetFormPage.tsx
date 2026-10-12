import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Flash, FormControl, Heading, Label, Spinner, TextInput } from '@primer/react';
import { PlusIcon, TrashIcon, XIcon } from '@primer/octicons-react';
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

  const results = useMemo(() => {
    if (!available) return [];
    const needle = search.trim().toLowerCase();
    return available
      .filter((repo) => !form.selected.some((item) => item.connectionId === repo.connectionId && item.repo === repo.repo))
      .filter((repo) => !needle || `${repo.host}/${repo.repo}`.toLowerCase().includes(needle))
      .slice(0, 60);
  }, [available, form.selected, search]);

  const addRepo = (repo: AvailableRepo) => {
    update({ selected: [...form.selected, { connectionId: repo.connectionId, repo: repo.repo, kind: repo.kind, host: repo.host }] });
    setSearch('');
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
            Could not list repositories ({repoError.message}). Connect the forge under Settings to see its repositories.
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
          <FormControl.Caption>
            Search across all your connected forges and add the repositories this review set should watch.
          </FormControl.Caption>
          <TextInput
            block
            leadingVisual={PlusIcon}
            placeholder="Filter repositories, e.g. targoninc/"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {available === null ? <Spinner size="small" aria-label="Loading repositories" /> : null}
          {available !== null && results.length > 0 ? (
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
          ) : null}
          {available !== null && results.length === 0 && search ? (
            <FormControl.Caption>No repositories match "{search}".</FormControl.Caption>
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
            A regular expression (no delimiters) that matches at most one branch per repository, for example release/v2\.\d+ (0 or 1
            match).
          </FormControl.Caption>
          <TextInput block value={form.branchRegex} onChange={(event) => update({ branchRegex: event.target.value })} placeholder="release/v2\\.\\d+" />
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
