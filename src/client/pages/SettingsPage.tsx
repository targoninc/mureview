import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Flash, Heading, Spinner, useConfirm } from '@primer/react';
import { ShieldIcon, TrashIcon } from '@primer/octicons-react';
import type { AuthProvider, MeResponse } from '../../shared/types';
import { api, basePath, del } from '../lib/api';
import { connectionAvatarUrl } from '../lib/format';
import { AdoForm, AtprotoForm, ForgejoForm, TangledForm, providerVisual } from '../components/Login';
import { ServiceGlyph, ServiceIcon, serviceDetail } from '../components/ServiceIcon';


const authProviderNames: Record<AuthProvider, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
  atproto: 'atproto',
  email: 'Email',
  entra: 'Entra ID',
};

export function SettingsPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AuthProvider | 'ado' | 'tangled' | null>(null);
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
    if (!authError) return;
    setError(authError);
    params.delete('authError');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  if (!me) return <div className="centered">{error ? <Flash variant="danger">{error}</Flash> : <Spinner aria-label="Loading" />}</div>;

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
          <div className="row">
            {me.providers.includes('github') ? (
              <Button
                leadingVisual={<ServiceGlyph kind="github" />}
                onClick={() => (window.location.href = `${basePath}/api/auth/login/github?mode=connect`)}
              >
                {me.connections.some((connection) => connection.kind === 'github') ? 'Reconnect GitHub' : 'Connect GitHub'}
              </Button>
            ) : null}
            <Button leadingVisual={<ServiceGlyph kind="forgejo" />} onClick={() => setAdding(adding === 'forgejo' ? null : 'forgejo')}>
              Connect Forgejo
            </Button>
            <Button
              leadingVisual={providerVisual('atproto')}
              onClick={() => setAdding(adding === 'atproto' ? null : 'atproto')}
            >
              Connect atproto
            </Button>
            <Button leadingVisual={<ServiceGlyph kind="ado" />} onClick={() => setAdding(adding === 'ado' ? null : 'ado')}>
              Connect Azure DevOps
            </Button>
            <Button leadingVisual={<ServiceGlyph kind="tangled" />} onClick={() => setAdding(adding === 'tangled' ? null : 'tangled')}>
              Connect Tangled
            </Button>
          </div>
          {adding === 'forgejo' ? (
            <div className="settings-panel">
              <ForgejoForm mode="connect" />
            </div>
          ) : null}
          {adding === 'atproto' ? (
            <div className="settings-panel">
              <AtprotoForm mode="connect" />
            </div>
          ) : null}
          {adding === 'ado' ? (
            <div className="settings-panel">
              <AdoForm
                onDone={() => {
                  setAdding(null);
                  load();
                }}
              />
            </div>
          ) : null}
          {adding === 'tangled' ? (
            <div className="settings-panel">
              <TangledForm
                onDone={() => {
                  setAdding(null);
                  load();
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="stack">
          <Heading as="h2" variant="small">
            Danger zone
          </Heading>
          <div className="settings-panel row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div className="stack" style={{ gap: 4 }}>
              <strong style={{ fontSize: 13 }}>Delete all mureview data</strong>
              <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>
                Removes every review set, comment and reviewed file stored here. Nothing on GitHub, Forgejo or Azure DevOps is touched,
                and your sign-in methods and connections stay.
              </span>
            </div>
            <Button variant="danger" leadingVisual={TrashIcon} onClick={removeAllData}>
              Delete data
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
