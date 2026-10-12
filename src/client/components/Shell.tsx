import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, Button, IconButton, Tooltip } from '@primer/react';
import { MarkGithubIcon, GearIcon, SignOutIcon, ShieldIcon } from '@primer/octicons-react';
import type { User } from '../../shared/types';
import { basePath } from '../lib/api';
import { useAppContext } from '../lib/appContext';

interface ShellProps {
  user: User;
  onSignOut: () => void;
  children: ReactNode;
}

export function Shell({ user, onSignOut, children }: ShellProps) {
  const { githubOAuthAppUrl } = useAppContext();
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-header-brand" href={`${basePath}/`}>
          <MarkGithubIcon size={24} />
          <span>mureview</span>
        </a>
        <div className="app-header-actions">
          {githubOAuthAppUrl ? (
            <Tooltip text="Manage GitHub app permissions (grant org access)">
              <Button
                as="a"
                href={githubOAuthAppUrl}
                target="_blank"
                rel="noreferrer"
                size="small"
                variant="invisible"
                leadingVisual={ShieldIcon}
                aria-label="App access"
              >
                App access
              </Button>
            </Tooltip>
          ) : null}
          <span className="app-header-user">
            <Avatar src={user.avatarUrl} size={24} alt={user.name} />
            {user.name}
          </span>
          <IconButton icon={GearIcon} aria-label="Settings" variant="invisible" onClick={() => navigate('/settings')} />
          <IconButton icon={SignOutIcon} aria-label="Sign out" variant="invisible" onClick={onSignOut} />
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
