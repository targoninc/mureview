import type { ReactNode } from 'react';
import { Avatar, IconButton } from '@primer/react';
import { MarkGithubIcon, SignOutIcon } from '@primer/octicons-react';
import type { User } from '../../shared/types';
import { basePath } from '../lib/api';

interface ShellProps {
  user: User;
  onSignOut: () => void;
  children: ReactNode;
}

export function Shell({ user, onSignOut, children }: ShellProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-header-brand" href={`${basePath}/`}>
          <MarkGithubIcon size={24} />
          <span>mureview</span>
        </a>
        <div className="app-header-actions">
          <span className="app-header-user">
            <Avatar src={user.avatarUrl} size={24} alt={user.login} />
            {user.login}
          </span>
          <IconButton icon={SignOutIcon} aria-label="Sign out" variant="invisible" onClick={onSignOut} />
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
