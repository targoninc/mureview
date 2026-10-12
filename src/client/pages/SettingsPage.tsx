import { useCallback, useEffect, useState } from 'react';
import { Avatar, Button, Flash, Heading, Label, Spinner, useConfirm } from '@primer/react';
import { MarkGithubIcon, ServerIcon, GlobeIcon, MailIcon, CloudIcon, ShieldIcon, TrashIcon } from '@primer/octicons-react';
import type { AuthProvider, ForgeKind, MeResponse } from '../../shared/types';
import { api, basePath, del } from '../lib/api';
import { AdoForm, AtprotoForm, ForgejoForm } from '../components/Login';

const forgeLabel: Record<ForgeKind, string> = { github: 'github', forgejo: 'forgejo', ado: 'azure devops' };

const providerIcon: Record<AuthProvider, typeof MarkGithubIcon> = {
  github: MarkGithubIcon,
  forgejo: ServerIcon,
  atproto: GlobeIcon,
  email: MailIcon,
};

export function SettingsPage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<AuthProvider | 'ado' | null>(null);
  const confirm = useConfirm();

  const load = useCallback(() => {
    api<MeResponse>('/me')
      .then(setMe)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  if (!me) return <div className="centered">{error ? <Flash variant="danger">{error}</Flash> : <Spinner aria-label="Loading" />}</div>;

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
              const Icon = providerIcon[identity.provider];
              return (
                <div className="repo-list-item" key={identity.id} style={{ cursor: 'default' }}>
                  <div className="row">
                    <Icon size={16} />
                    <span>{identity.displayName}</span>
                  </div>
                  <Label variant="secondary">{identity.provider}</Label>
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
                    <Avatar src={connection.avatarUrl} size={20} alt={connection.login} />
                    <span>
                      {connection.host}/{connection.login}
                    </span>
                  </div>
                  <div className="row">
                    <Label variant="secondary">{forgeLabel[connection.kind]}</Label>
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
            {me.providers.includes('github') && me.connections.every((connection) => connection.kind !== 'github') ? (
              <Button
                leadingVisual={MarkGithubIcon}
                onClick={() => (window.location.href = `${basePath}/api/auth/login/github?mode=connect`)}
              >
                Connect GitHub
              </Button>
            ) : null}
            <Button leadingVisual={ServerIcon} onClick={() => setAdding(adding === 'forgejo' ? null : 'forgejo')}>
              Connect Forgejo
            </Button>
            <Button leadingVisual={GlobeIcon} onClick={() => setAdding(adding === 'atproto' ? null : 'atproto')}>
              Connect atproto
            </Button>
            <Button leadingVisual={CloudIcon} onClick={() => setAdding(adding === 'ado' ? null : 'ado')}>
              Connect Azure DevOps
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
        </div>
      </div>
    </div>
  );
}
