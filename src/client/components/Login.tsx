import { Button, Flash } from '@primer/react';
import { MarkGithubIcon } from '@primer/octicons-react';
import { basePath } from '../lib/api';

export function Login({ error }: { error?: string }) {
  return (
    <div className="centered">
      <div className="stack" style={{ width: 360, textAlign: 'center' }}>
        <MarkGithubIcon size={48} />
        <h1>mureview</h1>
        <p style={{ color: 'var(--fgColor-muted)' }}>
          Multi-repository review sets, diffed against your target branch.
        </p>
        {error ? <Flash variant="danger">{error}</Flash> : null}
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
      </div>
    </div>
  );
}
