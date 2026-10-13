import { useEffect, useState } from 'react';
import { Button, Flash, FormControl, TextInput } from '@primer/react';
import { FileDiffIcon, MarkGithubIcon, ServerIcon, GlobeIcon, MailIcon } from '@primer/octicons-react';
import { ServiceGlyph } from './ServiceIcon';
import type { AuthProvider, ForgeConnectionInfo } from '../../shared/types';
import { basePath, post } from '../lib/api';

interface LoginProps {
  providers: AuthProvider[];
  onSignedIn: () => void;
}

const providerLabel: Record<AuthProvider, string> = {
  github: 'GitHub',
  forgejo: 'Forgejo',
  atproto: 'atproto',
  email: 'Email',
  entra: 'Entra ID',
};

const providerIcon: Record<AuthProvider, typeof MarkGithubIcon> = {
  github: MarkGithubIcon,
  forgejo: ServerIcon,
  atproto: GlobeIcon,
  email: MailIcon,
  entra: GlobeIcon,
};

/** The four-square Microsoft mark, in the surrounding text colour. */
function MicrosoftGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="10" height="10" />
      <rect x="13" y="1" width="10" height="10" opacity="0.75" />
      <rect x="1" y="13" width="10" height="10" opacity="0.75" />
      <rect x="13" y="13" width="10" height="10" />
    </svg>
  );
}

export function providerVisual(provider: AuthProvider) {
  if (provider === 'github' || provider === 'forgejo') return <ServiceGlyph kind={provider} size={16} />;
  if (provider === 'entra') return <MicrosoftGlyph size={16} />;
  const Icon = providerIcon[provider];
  return <Icon size={16} />;
}

export function Login({ providers, onSignedIn }: LoginProps) {
  const [choice, setChoice] = useState<AuthProvider | null>(null);
  const [register, setRegister] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('authError');
    if (!error) return;
    setAuthError(error);
    params.delete('authError');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  return (
    <div className="centered">
      <div className="stack" style={{ width: 440, maxWidth: '100%', padding: 24 }}>
        <div className="login-logo">
          <FileDiffIcon size={48} />
        </div>
        <h1 style={{ margin: 0, textAlign: 'center' }}>mureview</h1>
        {authError ? <Flash variant="danger">{authError}</Flash> : null}
        <p style={{ margin: 0, color: 'var(--fgColor-muted)', textAlign: 'center' }}>
          Review a set of branches across many repositories as one pull request: every diff, every comment and the merge in a
          single place.
        </p>

        {choice === null ? (
          <div className="stack">
            {providers.map((provider) => {
              return (
                <Button
                  key={provider}
                  block
                  size="large"
                  variant={provider === 'github' ? 'primary' : 'default'}
                  leadingVisual={providerVisual(provider)}
                  onClick={() => {
                    if (provider === 'github' || provider === 'entra') window.location.href = `${basePath}/api/auth/login/${provider}`;
                    else setChoice(provider);
                  }}
                >
                  Continue with {providerLabel[provider]}
                </Button>
              );
            })}
            <a className="source-link" href="https://github.com/targoninc/mureview" target="_blank" rel="noreferrer">
              <MarkGithubIcon size={16} />
              Source on GitHub
            </a>
          </div>
        ) : null}

        {choice === 'email' ? (
          <EmailForm register={register} onToggle={() => setRegister((value) => !value)} onSignedIn={onSignedIn} onBack={() => setChoice(null)} />
        ) : null}
        {choice === 'forgejo' ? <ForgejoForm mode="login" onBack={() => setChoice(null)} /> : null}
        {choice === 'atproto' ? <AtprotoForm mode="login" onBack={() => setChoice(null)} /> : null}
      </div>
    </div>
  );
}

export function EmailForm({
  register: initialRegister,
  onToggle,
  onSignedIn,
  onBack,
}: {
  register: boolean;
  onToggle: () => void;
  onSignedIn: () => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (initialRegister) await post('/auth/register', { email, password, name });
      else await post('/auth/login', { email, password });
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2 style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>{initialRegister ? 'Create an account' : 'Sign in with email'}</h2>
      {error ? <Flash variant="danger">{error}</Flash> : null}
      <FormControl>
        <FormControl.Label>Email</FormControl.Label>
        <TextInput block type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </FormControl>
      {initialRegister ? (
        <FormControl>
          <FormControl.Label>Name (optional)</FormControl.Label>
          <TextInput block value={name} onChange={(event) => setName(event.target.value)} />
        </FormControl>
      ) : null}
      <FormControl>
        <FormControl.Label>Password</FormControl.Label>
        <TextInput block type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        {initialRegister ? <FormControl.Caption>At least 8 characters.</FormControl.Caption> : null}
      </FormControl>
      <div className="form-actions">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !email || !password}>
          {busy ? 'Working…' : initialRegister ? 'Create account' : 'Sign in'}
        </Button>
      </div>
      <button type="button" className="link-button" onClick={onToggle}>
        {initialRegister ? 'I already have an account' : 'Create an account instead'}
      </button>
    </div>
  );
}

export function ForgejoForm({ mode, onBack }: { mode: 'login' | 'connect'; onBack?: () => void }) {
  const [host, setHost] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const callback = `${window.location.origin}${basePath}/api/auth/callback/forgejo`;

  return (
    <form className="stack" method="post" action={`${basePath}/api/auth/login/forgejo`}>
      <h2 style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>{mode === 'connect' ? 'Connect a Forgejo instance' : 'Sign in with Forgejo'}</h2>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--fgColor-muted)' }}>
        Register an OAuth2 application on your instance (Settings → Applications) with the callback URL{' '}
        <span className="mono">{callback}</span>, then paste its credentials here.
      </p>
      <FormControl>
        <FormControl.Label>Instance URL</FormControl.Label>
        <TextInput block name="host" placeholder="https://git.example.org" value={host} onChange={(event) => setHost(event.target.value)} />
      </FormControl>
      <FormControl>
        <FormControl.Label>Client ID</FormControl.Label>
        <TextInput block name="clientId" value={clientId} onChange={(event) => setClientId(event.target.value)} />
      </FormControl>
      <FormControl>
        <FormControl.Label>Client secret</FormControl.Label>
        <TextInput block name="clientSecret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
      </FormControl>
      <input type="hidden" name="mode" value={mode} />
      <div className="form-actions">
        {onBack ? <Button onClick={onBack}>Back</Button> : null}
        <Button variant="primary" type="submit" disabled={!host || !clientId || !clientSecret}>
          Continue
        </Button>
      </div>
    </form>
  );
}

export function AdoForm({ onDone, onBack }: { onDone: () => void; onBack?: () => void }) {
  const [organization, setOrganization] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/connections/ado', { organization, token });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <h2 style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>Connect Azure DevOps</h2>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--fgColor-muted)' }}>
        Create a personal access token in Azure DevOps (User settings → Personal access tokens) with the Code (read &amp; write) and
        Project and Team (read) scopes.
      </p>
      {error ? <Flash variant="danger">{error}</Flash> : null}
      <FormControl>
        <FormControl.Label>Organization</FormControl.Label>
        <TextInput block placeholder="myorg or https://dev.azure.com/myorg" value={organization} onChange={(event) => setOrganization(event.target.value)} />
      </FormControl>
      <FormControl>
        <FormControl.Label>Personal access token</FormControl.Label>
        <TextInput block type="password" value={token} onChange={(event) => setToken(event.target.value)} />
      </FormControl>
      <div className="form-actions">
        {onBack ? <Button onClick={onBack}>Back</Button> : null}
        <Button variant="primary" onClick={submit} disabled={busy || !organization || !token}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </div>
  );
}

export function TangledForm({ onBack }: { onBack?: () => void }) {
  const [handle, setHandle] = useState('');
  return (
    <div className="stack">
      <h2 style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>Connect Tangled</h2>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--fgColor-muted)' }}>
        Tangled uses your atproto account. Sign in with the handle that owns your repositories: mureview asks for permission
        to create pull requests and comments on the knots hosting them.
      </p>
      <FormControl>
        <FormControl.Label>atproto handle</FormControl.Label>
        <TextInput block placeholder="alice.bsky.social" value={handle} onChange={(event) => setHandle(event.target.value)} />
      </FormControl>
      <div className="form-actions">
        {onBack ? <Button onClick={onBack}>Back</Button> : null}
        <Button
          variant="primary"
          disabled={!handle}
          onClick={() => {
            const params = new URLSearchParams({ handle, mode: 'connect', tangled: '1' });
            window.location.href = `${basePath}/api/auth/login/atproto?${params.toString()}`;
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

export function AtprotoForm({ mode, onBack }: { mode: 'login' | 'connect'; onBack?: () => void }) {
  const [handle, setHandle] = useState('');
  return (
    <div className="stack">
      <h2 style={{ margin: 0, textAlign: 'center', fontSize: 16 }}>{mode === 'connect' ? 'Connect atproto' : 'Sign in with atproto'}</h2>
      <FormControl>
        <FormControl.Label>Handle</FormControl.Label>
        <TextInput block placeholder="alice.bsky.social" value={handle} onChange={(event) => setHandle(event.target.value)} />
      </FormControl>
      <div className="form-actions">
        {onBack ? <Button onClick={onBack}>Back</Button> : null}
        <Button
          variant="primary"
          disabled={!handle}
          onClick={() => {
            const params = new URLSearchParams({ handle, mode });
            window.location.href = `${basePath}/api/auth/login/atproto?${params.toString()}`;
          }}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
