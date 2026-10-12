import { Button } from '@primer/react';
import { MarkGithubIcon } from '@primer/octicons-react';
import { basePath } from '../lib/api';

export function Login() {
  return (
    <div className="centered">
      <div className="stack" style={{ width: 400, maxWidth: '100%', textAlign: 'center', padding: 24 }}>
        <div className="login-logo">
          <MarkGithubIcon size={48} />
        </div>
        <h1 style={{ margin: 0 }}>mureview</h1>
        <p style={{ margin: 0, color: 'var(--fgColor-muted)' }}>
          Review a set of branches across many repositories as one pull request: every diff, every comment and the merge in a
          single place.
        </p>
        <Button
          variant="primary"
          leadingVisual={MarkGithubIcon}
          size="large"
          block
          onClick={() => {
            window.location.href = `${basePath}/api/auth/login`;
          }}
        >
          Sign in with GitHub
        </Button>
        <a className="source-link" href="https://github.com/targoninc/mureview" target="_blank" rel="noreferrer">
          <MarkGithubIcon size={16} />
          Source on GitHub
        </a>
      </div>
    </div>
  );
}
