import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, Flash, Heading, Spinner, Textarea, useConfirm } from '@primer/react';
import { SyncIcon, TrashIcon } from '@primer/octicons-react';
import type { McpKey } from '../../shared/types';
import { api, del, post } from '../lib/api';
import { timeAgo } from '../lib/format';

/** Creates MCP keys and lists the agents that have used them. */
export function McpSettings() {
  const [keys, setKeys] = useState<McpKey[] | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    api<{ keys: McpKey[] }>('/mcp/keys')
      .then((result) => setKeys(result.keys))
      .catch((err: Error) => {
        setKeys([]);
        setError(err.message);
      });
  }, []);

  useEffect(load, [load]);

  const createKey = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const result = await post<{ prompt: string }>('/mcp/keys', {});
      load();
      try {
        await navigator.clipboard.writeText(result.prompt);
        setPrompt(null);
        setNotice('Setup prompt copied. Paste it into your agent.');
      } catch {
        setPrompt(result.prompt);
        setError('Could not copy automatically. Select the prompt text and copy it manually.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const copyPrompt = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice('Setup prompt copied. Paste it into your agent.');
      setPrompt(null);
    } catch {
      setError('Could not copy automatically. Select the prompt text and copy it manually.');
    }
  };

  const removeKey = async (key: McpKey) => {
    const approved = await confirm({
      title: 'Disconnect this agent?',
      content: 'The key is deleted and stops working immediately.',
      confirmButtonContent: 'Delete key',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    setDeleting(key.id);
    setError(null);
    try {
      await del(`/mcp/keys/${key.id}`);
      setKeys((current) => current?.filter((entry) => entry.id !== key.id) ?? current);
      setNotice('Agent key deleted.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="stack">
      <Heading as="h2" variant="small">
        Agents (MCP)
      </Heading>
      <div className="settings-panel stack" style={{ gap: 14 }}>
        {error ? <Flash variant="danger">{error}</Flash> : null}
        {notice ? <Flash variant="success">{notice}</Flash> : null}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div className="stack" style={{ gap: 4 }}>
            <strong style={{ fontSize: 13 }}>Connect an agent over MCP</strong>
            <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
              Copy a setup prompt, then paste it into Claude Code, Codex, Cursor, VS Code or another MCP
              client. Each prompt gets its own key. Keys appear below after an agent connects and lists the
              available tools.
            </span>
          </div>
          <Button variant="primary" onClick={createKey} disabled={creating}>
            {creating ? 'Creating…' : 'Copy setup prompt'}
          </Button>
        </div>

        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <strong style={{ fontSize: 13 }}>Connected keys</strong>
            <Button
              size="small"
              variant="invisible"
              leadingVisual={SyncIcon}
              onClick={load}
              aria-label="Refresh connected keys"
            >
              Refresh
            </Button>
          </div>
          {keys === null ? (
            <Spinner size="small" aria-label="Loading agent keys" />
          ) : keys.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>No agents connected yet.</span>
          ) : (
            <div className="repo-list">
              {keys.map((key) => (
                <div className="repo-list-item" key={key.id} style={{ cursor: 'default' }}>
                  <div className="stack" style={{ gap: 2 }}>
                    <span className="row" style={{ gap: 6 }}>
                      <strong>{key.clientName ?? 'MCP client'}</strong>
                      <span className="mono" style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                        {key.prefix}…
                      </span>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                      Last used {timeAgo(key.lastUsedAt)} · added {timeAgo(key.createdAt)}
                    </span>
                  </div>
                  <Button
                    size="small"
                    variant="danger"
                    leadingVisual={TrashIcon}
                    disabled={deleting === key.id}
                    onClick={() => removeKey(key)}
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
          )}
          <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
            Deleting a key disconnects that agent immediately. Keys that have never listed tools stay hidden.
          </span>
        </div>
      </div>

      {prompt ? (
        <Dialog
          title="Agent setup prompt"
          width="large"
          onClose={() => setPrompt(null)}
          footerButtons={[
            { content: 'Close', onClick: () => setPrompt(null) },
            { content: 'Copy prompt', buttonType: 'primary', onClick: copyPrompt },
          ]}
        >
          <div className="stack" style={{ gap: 12 }}>
            <span style={{ fontSize: 13 }}>
              Paste this into your agent. It contains a new key that is shown only once.
            </span>
            <Textarea
              readOnly
              rows={16}
              value={prompt}
              aria-label="Agent setup prompt"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
