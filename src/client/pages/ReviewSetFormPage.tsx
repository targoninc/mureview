import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Flash, FormControl, Heading, Spinner, TextInput, Textarea } from '@primer/react';
import { TrashIcon } from '@primer/octicons-react';
import type { ReviewSetDetail } from '../../shared/types';
import { del, post, put } from '../lib/api';
import { useDetail } from '../lib/useDetail';

interface FormState {
  name: string;
  reposText: string;
  branchRegex: string;
  targetBranch: string;
}

const emptyForm: FormState = { name: '', reposText: '', branchRegex: '', targetBranch: 'main' };

export function ReviewSetFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const { detail, error: loadError } = useDetail(id);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!detail) return;
    setForm({
      name: detail.reviewSet.name,
      reposText: detail.reviewSet.repos.join('\n'),
      branchRegex: detail.reviewSet.branchRegex,
      targetBranch: detail.reviewSet.targetBranch,
    });
  }, [detail]);

  const update = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const body = {
      name: form.name,
      repos: form.reposText.split('\n').map((line) => line.trim()).filter(Boolean),
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
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <Heading as="h1" variant="medium">{editing ? 'Review set settings' : 'New review set'}</Heading>
        {loadError ? <Flash variant="danger">{loadError}</Flash> : null}
        {error ? <Flash variant="danger">{error}</Flash> : null}
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
            One repository per line as owner/name (or a GitHub URL). You need access to every repository you list.
          </FormControl.Caption>
          <Textarea
            block
            rows={4}
            value={form.reposText}
            onChange={(event) => update({ reposText: event.target.value })}
            placeholder={'targoninc/example-api\ntargoninc/example-web'}
          />
        </FormControl>

        <FormControl>
          <FormControl.Label>Branch pattern</FormControl.Label>
          <FormControl.Caption>
            A regular expression (no delimiters) that matches at most one branch per repository, for example release/v2\.\d+ (0 or 1 match).
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
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create review set'}
          </Button>
        </div>
      </div>
    </div>
  );
}
