import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Avatar, Button, Dialog, Flash, Heading, Select, Spinner, Textarea, ToggleSwitch, useConfirm } from '@primer/react';
import { ShieldIcon, SyncIcon, TrashIcon } from '@primer/octicons-react';
import type { AuthProvider, ForgeKind, McpKey, MeResponse, User } from '../../shared/types';
import { useAppContext } from '../lib/appContext';
import { DEFAULT_DIFF_FONT_SIZE, DEFAULT_MONO_FONT, DIFF_FONT_SIZES, monoFontFamily, monoFontOption, type MonoFontOption } from '../../shared/fonts';
import { FontPickerDialog } from '../components/FontPicker';
import { api, basePath, del, post, put } from '../lib/api';
import { connectionAvatarUrl, timeAgo } from '../lib/format';
import { AdoForm, ForgejoForm, TangledForm, providerVisual } from '../components/Login';
import { ServiceGlyph, ServiceIcon, serviceDetail, serviceNames } from '../components/ServiceIcon';


const authProviderNames: Record<AuthProvider, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
  atproto: 'atproto',
  email: 'Email',
  entra: 'Entra ID',
};

/** What a "connected" query parameter (from the auth callbacks) refers to. */
function connectedName(key: string): string {
  if (key in serviceNames) return serviceNames[key as ForgeKind];
  if (key in authProviderNames) return authProviderNames[key as AuthProvider];
  return key;
}

type ConnectTarget = 'github' | 'forgejo' | 'entra' | 'ado' | 'tangled';

interface ConnectOption {
  key: ConnectTarget;
  name: string;
  detail: string;
  icon: ReactNode;
}

export function SettingsPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState<ConnectTarget | null>(null);
  const [savingFont, setSavingFont] = useState<string | null>(null);
  const [savingToggle, setSavingToggle] = useState<string | null>(null);
  const [savingDiffSize, setSavingDiffSize] = useState(false);
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const [mcpKeys, setMcpKeys] = useState<McpKey[] | null>(null);
  const [mcpPrompt, setMcpPrompt] = useState<string | null>(null);
  const [creatingMcpKey, setCreatingMcpKey] = useState(false);
  const [deletingMcpKey, setDeletingMcpKey] = useState<number | null>(null);
  const confirm = useConfirm();
  const { updateUser } = useAppContext();

  // The settings page and the rest of the app each keep their own copy of the
  // user; a saved preference goes into both.
  const applyUser = (patch: Partial<User>) => {
    updateUser(patch);
    setMe((current) => (current?.user ? { ...current, user: { ...current.user, ...patch } } : current));
  };

  const load = useCallback(() => {
    api<MeResponse>('/me')
      .then(setMe)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const loadMcpKeys = useCallback(() => {
    api<{ keys: McpKey[] }>('/mcp/keys')
      .then((result) => setMcpKeys(result.keys))
      .catch((err: Error) => {
        setMcpKeys([]);
        setError(err.message);
      });
  }, []);

  useEffect(() => {
    if (me?.user) loadMcpKeys();
  }, [me?.user, loadMcpKeys]);

  const createAgentKey = async () => {
    if (creatingMcpKey) return;
    setCreatingMcpKey(true);
    setError(null);
    setNotice(null);
    try {
      const result = await post<{ prompt: string; prefix: string }>('/mcp/keys', {});
      loadMcpKeys();
      try {
        await navigator.clipboard.writeText(result.prompt);
        setMcpPrompt(null);
        setNotice('Setup prompt copied. Paste it into your agent.');
      } catch {
        setMcpPrompt(result.prompt);
        setError('Could not copy automatically. Select the prompt text and copy it manually.');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreatingMcpKey(false);
    }
  };

  const copyMcpPrompt = async () => {
    if (!mcpPrompt) return;
    try {
      await navigator.clipboard.writeText(mcpPrompt);
      setNotice('Setup prompt copied. Paste it into your agent.');
      setMcpPrompt(null);
    } catch {
      setError('Could not copy automatically. Select the prompt text and copy it manually.');
    }
  };

  const removeMcpKey = async (mcpKey: McpKey) => {
    const approved = await confirm({
      title: 'Disconnect this agent?',
      content: 'The key is deleted and stops working immediately.',
      confirmButtonContent: 'Delete key',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    setDeletingMcpKey(mcpKey.id);
    setError(null);
    try {
      await del(`/mcp/keys/${mcpKey.id}`);
      setMcpKeys((current) => current?.filter((entry) => entry.id !== mcpKey.id) ?? current);
      setNotice('Agent key deleted.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingMcpKey(null);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('authError');
    const connected = params.get('connected');
    if (!authError && !connected) return;
    if (authError) setError(authError);
    if (connected) setNotice(`${connectedName(connected)} connected.`);
    params.delete('authError');
    params.delete('connected');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  const chooseFont = async (font: MonoFontOption) => {
    if (savingFont) return;
    setSavingFont(font.id);
    setError(null);
    try {
      await put('/me/preferences', { monoFont: font.id });
      document.documentElement.style.setProperty('--font-mono', monoFontFamily(font.id));
      applyUser({ monoFont: font.id });
      setNotice(`${font.label} is now the monospace font.`);
      setFontPickerOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFont(null);
    }
  };

  const chooseDiffFontSize = async (size: number) => {
    if (savingDiffSize) return;
    setSavingDiffSize(true);
    setError(null);
    applyUser({ diffFontSize: size });
    try {
      await put('/me/preferences', { diffFontSize: size });
    } catch (err) {
      applyUser({ diffFontSize: me?.user?.diffFontSize ?? DEFAULT_DIFF_FONT_SIZE });
      setError((err as Error).message);
    } finally {
      setSavingDiffSize(false);
    }
  };

  const setTogglePreference = async (key: 'autoMarkViewed' | 'hideViewedFiles', value: boolean) => {
    if (savingToggle) return;
    setSavingToggle(key);
    setError(null);
    applyUser({ [key]: value });
    try {
      await put('/me/preferences', { [key]: value });
    } catch (err) {
      applyUser({ [key]: !value });
      setError((err as Error).message);
    } finally {
      setSavingToggle(null);
    }
  };

  if (!me) return <div className="centered">{error ? <Flash variant="danger">{error}</Flash> : <Spinner aria-label="Loading" />}</div>;

  const currentFont = me.user?.monoFont ?? DEFAULT_MONO_FONT;
  const currentFontLabel = monoFontOption(currentFont).label;
  const currentDiffFontSize = me.user?.diffFontSize ?? DEFAULT_DIFF_FONT_SIZE;

  const hasGithub = me.connections.some((connection) => connection.kind === 'github');
  const connectOptions: ConnectOption[] = [
    ...(me.providers.includes('github')
      ? [{ key: 'github' as const, name: 'GitHub', detail: 'Sign-in and forge connection', icon: <ServiceGlyph kind="github" /> }]
      : []),
    { key: 'forgejo', name: 'Forgejo', detail: 'Sign-in and forge connection', icon: <ServiceGlyph kind="forgejo" /> },
    { key: 'ado', name: 'Azure DevOps', detail: 'Forge connection only (personal access token)', icon: <ServiceGlyph kind="ado" /> },
    {
      key: 'tangled',
      name: 'Tangled',
      detail: 'Sign-in and forge connection — uses your atproto account',
      icon: <ServiceGlyph kind="tangled" />,
    },
    ...(me.providers.includes('entra')
      ? [{ key: 'entra' as const, name: 'Entra ID', detail: 'Sign-in only', icon: providerVisual('entra') }]
      : []),
  ];

  const finishConnect = (name: string) => {
    setAdding(null);
    setNotice(`${name} connected.`);
    load();
  };

  const removeAllData = async () => {
    const approved = await confirm({
      title: 'Delete all mureview data?',
      content: 'Every review set, its comments and reviewed files are removed. The repositories on the forges are not changed.',
      confirmButtonContent: 'Delete everything',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    try {
      await del('/account/data');
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeConnection = async (id: number, label: string) => {
    const approved = await confirm({
      title: `Disconnect ${label}?`,
      content: 'Review set repositories that use this connection must be removed first.',
      confirmButtonContent: 'Disconnect',
      confirmButtonType: 'danger',
    });
    if (!approved) return;
    try {
      await del(`/connections/${id}`);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="page-scroll">
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <Heading as="h1" variant="medium">
          Account
        </Heading>
        {error ? <Flash variant="danger">{error}</Flash> : null}
        {notice ? <Flash variant="success">{notice}</Flash> : null}

        <div className="stack">
          <Heading as="h2" variant="small">
            Sign-in methods
          </Heading>
          <div className="repo-list">
            {me.identities.map((identity) => {
              const label = authProviderNames[identity.provider];
              return (
                <div className="repo-list-item" key={identity.id} style={{ cursor: 'default' }}>
                  <div className="row">
                    <span className="service-icon" role="img" aria-label={label} title={label}>
                      {providerVisual(identity.provider)}
                    </span>
                    <span>{identity.displayName}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Forge connections
          </Heading>
          {me.connections.length === 0 ? (
            <span style={{ color: 'var(--fgColor-muted)' }}>No forges connected yet.</span>
          ) : (
            <div className="repo-list">
              {me.connections.map((connection) => (
                <div className="repo-list-item" key={connection.id} style={{ cursor: 'default' }}>
                  <div className="row">
                    <ServiceIcon kind={connection.kind} detail={serviceDetail(connection.kind, connection)} />
                    <Avatar src={connectionAvatarUrl(connection)} size={20} alt={connection.login} />
                    <span>
                      {connection.host}/{connection.login}
                    </span>
                  </div>
                  {connection.kind === 'tangled' && connection.writeReady === false ? (
                    <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                      Pull requests and comments are written with your atproto account. Reconnect Tangled below to sign in with
                      atproto as <span className="mono">{connection.login}</span>.
                    </span>
                  ) : null}
                  <div className="row">
                    {connection.manageUrl ? (
                      <Button
                        as="a"
                        href={connection.manageUrl}
                        target="_blank"
                        rel="noreferrer"
                        size="small"
                        variant="invisible"
                        leadingVisual={ShieldIcon}
                      >
                        Manage access
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      leadingVisual={TrashIcon}
                      variant="danger"
                      onClick={() => removeConnection(connection.id, `${connection.host}/${connection.login}`)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {me.githubAppSlug ? (
          <div className="stack">
            <Heading as="h2" variant="small">
              GitHub App installations
            </Heading>
            <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
              Repositories an installation covers get webhooks and installation tokens. What you can do is still based
              on your own GitHub access; the app's permissions only stand in where your account cannot reach the
              repository.
            </span>
            <div className="repo-list">
              {me.githubInstallations.length === 0 ? (
                <div className="repo-list-item" style={{ cursor: 'default' }}>
                  <span style={{ color: 'var(--fgColor-muted)' }}>No installations yet.</span>
                </div>
              ) : (
                me.githubInstallations.map((installation) => {
                  const missing = [
                    installation.contentsWrite ? '' : 'Contents (write)',
                    installation.pullRequestsWrite ? '' : 'Pull requests (write)',
                  ].filter(Boolean);
                  return (
                  <div className="repo-list-item" key={installation.id} style={{ cursor: 'default' }}>
                    <div className="row">
                      <ServiceGlyph kind="github" />
                      <span>
                        <strong>{installation.account}</strong>{' '}
                        <span style={{ color: 'var(--fgColor-muted)', fontSize: 12 }}>({installation.selection})</span>
                      </span>
                    </div>
                    <Button
                      as="a"
                      href={
                        installation.organization
                          ? `https://github.com/organizations/${installation.account}/settings/installations/${installation.id}`
                          : `https://github.com/settings/installations/${installation.id}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      size="small"
                      variant="invisible"
                    >
                      Manage
                    </Button>
                    {missing.length > 0 ? (
                      <span style={{ fontSize: 12, color: 'var(--fgColor-attention)' }}>
                        Merging is disabled for this installation: grant {missing.join(' and ')} on the app, then approve
                        the update on GitHub.
                      </span>
                    ) : null}
                  </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}

        <div className="stack">
          <Heading as="h2" variant="small">
            Add a connection
          </Heading>
          <div className="repo-list">
            {connectOptions.map((option) => (
              <Fragment key={option.key}>
                <div className="repo-list-item" style={{ cursor: 'default' }}>
                  <div className="row">
                    <span className="service-icon" role="img" aria-label={option.name} title={option.name}>
                      {option.icon}
                    </span>
                    <div className="stack" style={{ gap: 2 }}>
                      <span>{option.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>{option.detail}</span>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    {option.key === 'github' && me.githubAppSlug ? (
                      <Button
                        as="a"
                        href={`https://github.com/apps/${me.githubAppSlug}/installations/new`}
                        target="_blank"
                        rel="noreferrer"
                        size="small"
                        variant="invisible"
                      >
                        Install the GitHub App
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      onClick={() => {
                        setNotice(null);
                        if (option.key === 'github' || option.key === 'entra') {
                          window.location.href = `${basePath}/api/auth/login/${option.key}?mode=connect`;
                          return;
                        }
                        setAdding(adding === option.key ? null : option.key);
                      }}
                    >
                      {option.key === 'github' && hasGithub ? 'Connect another account' : `Connect ${option.name}`}
                    </Button>
                  </div>
                </div>
                {adding === option.key ? (
                  <div className="settings-panel" style={{ marginBottom: 8 }}>
                    {option.key === 'forgejo' ? <ForgejoForm mode="connect" /> : null}
                    {option.key === 'ado' ? <AdoForm onDone={() => finishConnect('Azure DevOps')} /> : null}
                    {option.key === 'tangled' ? <TangledForm /> : null}
                  </div>
                ) : null}
              </Fragment>
            ))}
          </div>
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Diffs
          </Heading>
          <div className="settings-panel stack" style={{ gap: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>{currentFontLabel}</strong>
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                  Used for diffs, file paths and code. All fonts are bundled with mureview.
                </span>
              </div>
              <Button onClick={() => setFontPickerOpen(true)}>Change font</Button>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>Diff text size</strong>
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                  The size of code in diffs and the combined stack view.
                </span>
              </div>
              <Select
                aria-label="Diff text size"
                value={String(currentDiffFontSize)}
                disabled={savingDiffSize}
                onChange={(event) => chooseDiffFontSize(Number(event.target.value))}
              >
                {DIFF_FONT_SIZES.map((size) => (
                  <Select.Option key={size} value={String(size)}>
                    {size}px
                  </Select.Option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Reviewing
          </Heading>
          <div className="settings-panel stack" style={{ gap: 16 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
              <div className="stack" style={{ gap: 4, flex: 1 }}>
                <strong id="pref-auto-mark-viewed" style={{ fontSize: 13 }}>
                  Mark files as viewed automatically
                </strong>
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                  A file counts once it was fully visible in the all-files diff view, or when you leave it in the
                  single file view.
                </span>
              </div>
              <ToggleSwitch
                checked={me.user?.autoMarkViewed ?? false}
                disabled={savingToggle !== null}
                aria-labelledby="pref-auto-mark-viewed"
                onChange={(checked) => setTogglePreference('autoMarkViewed', checked)}
              />
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'nowrap' }}>
              <div className="stack" style={{ gap: 4, flex: 1 }}>
                <strong id="pref-hide-viewed-files" style={{ fontSize: 13 }}>
                  Hide viewed files in the file tree
                </strong>
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                  Viewed files leave the tree; the pull request header then offers a button to show them anyway.
                </span>
              </div>
              <ToggleSwitch
                checked={me.user?.hideViewedFiles ?? false}
                disabled={savingToggle !== null}
                aria-labelledby="pref-hide-viewed-files"
                onChange={(checked) => setTogglePreference('hideViewedFiles', checked)}
              />
            </div>
          </div>
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Agents (MCP)
          </Heading>
          <div className="settings-panel stack" style={{ gap: 14 }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
              <div className="stack" style={{ gap: 4 }}>
                <strong style={{ fontSize: 13 }}>Connect an agent over MCP</strong>
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                  Copy a setup prompt, then paste it into Claude Code, Codex, Cursor, VS Code or another MCP
                  client. Each prompt gets its own key. Keys appear below after an agent connects and lists the
                  available tools.
                </span>
              </div>
              <Button variant="primary" onClick={createAgentKey} disabled={creatingMcpKey}>
                {creatingMcpKey ? 'Creating…' : 'Copy setup prompt'}
              </Button>
            </div>

            <div className="stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                <strong style={{ fontSize: 13 }}>Connected keys</strong>
                <Button
                  size="small"
                  variant="invisible"
                  leadingVisual={SyncIcon}
                  onClick={loadMcpKeys}
                  aria-label="Refresh connected keys"
                >
                  Refresh
                </Button>
              </div>
              {mcpKeys === null ? (
                <Spinner size="small" aria-label="Loading agent keys" />
              ) : mcpKeys.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>No agents connected yet.</span>
              ) : (
                <div className="repo-list">
                  {mcpKeys.map((mcpKey) => (
                    <div className="repo-list-item" key={mcpKey.id} style={{ cursor: 'default' }}>
                      <div className="stack" style={{ gap: 2 }}>
                        <span className="row" style={{ gap: 6 }}>
                          <strong>{mcpKey.clientName ?? 'MCP client'}</strong>
                          <span className="mono" style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                            {mcpKey.prefix}…
                          </span>
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                          Last used {timeAgo(mcpKey.lastUsedAt)} · added {timeAgo(mcpKey.createdAt)}
                        </span>
                      </div>
                      <Button
                        size="small"
                        variant="danger"
                        leadingVisual={TrashIcon}
                        disabled={deletingMcpKey === mcpKey.id}
                        onClick={() => removeMcpKey(mcpKey)}
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
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Danger zone
          </Heading>
          <div className="settings-panel row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div className="stack" style={{ gap: 4 }}>
              <strong style={{ fontSize: 13 }}>Delete all mureview data</strong>
              <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                Removes every review set, comment and reviewed file stored here. Nothing on your forges is touched,
                and your sign-in methods and connections stay.
              </span>
            </div>
            <Button variant="danger" leadingVisual={TrashIcon} onClick={removeAllData}>
              Delete data
            </Button>
          </div>
        </div>
      </div>

      {fontPickerOpen ? (
        <FontPickerDialog
          current={currentFont}
          saving={savingFont !== null}
          onClose={() => setFontPickerOpen(false)}
          onPick={chooseFont}
        />
      ) : null}

      {mcpPrompt ? (
        <Dialog
          title="Agent setup prompt"
          width="large"
          onClose={() => setMcpPrompt(null)}
          footerButtons={[
            { content: 'Close', onClick: () => setMcpPrompt(null) },
            { content: 'Copy prompt', buttonType: 'primary', onClick: copyMcpPrompt },
          ]}
        >
          <div className="stack" style={{ gap: 12 }}>
            <span style={{ fontSize: 13 }}>
              Paste this into your agent. It contains a new key that is shown only once.
            </span>
            <Textarea
              readOnly
              rows={16}
              value={mcpPrompt}
              aria-label="Agent setup prompt"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
