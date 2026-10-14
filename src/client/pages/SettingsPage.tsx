import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Avatar, Button, Flash, Heading, Spinner, useConfirm } from '@primer/react';
import { ShieldIcon, TrashIcon } from '@primer/octicons-react';
import type { AuthProvider, ForgeKind, MeResponse } from '../../shared/types';
import { DEFAULT_MONO_FONT, monoFontFamily, monoFontOption, type MonoFontOption } from '../../shared/fonts';
import { FontPickerDialog } from '../components/FontPicker';
import { api, basePath, del, put } from '../lib/api';
import { connectionAvatarUrl } from '../lib/format';
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
  const [fontPickerOpen, setFontPickerOpen] = useState(false);
  const confirm = useConfirm();

  const load = useCallback(() => {
    api<MeResponse>('/me')
      .then(setMe)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

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
      setMe((current) =>
        current ? { ...current, user: current.user ? { ...current.user, monoFont: font.id } : null } : current,
      );
      setNotice(`${font.label} is now the monospace font.`);
      setFontPickerOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFont(null);
    }
  };

  if (!me) return <div className="centered">{error ? <Flash variant="danger">{error}</Flash> : <Spinner aria-label="Loading" />}</div>;

  const currentFont = me.user?.monoFont ?? DEFAULT_MONO_FONT;
  const currentFontLabel = monoFontOption(currentFont).label;

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
            Monospace font
          </Heading>
          <div className="settings-panel row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div className="stack" style={{ gap: 4 }}>
              <strong style={{ fontSize: 13 }}>{currentFontLabel}</strong>
              <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                Used for diffs, file paths and code. All fonts are bundled with mureview.
              </span>
            </div>
            <Button onClick={() => setFontPickerOpen(true)}>Change font</Button>
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
    </div>
  );
}
