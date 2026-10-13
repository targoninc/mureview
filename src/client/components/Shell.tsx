import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, IconButton } from '@primer/react';
import { FileDiffIcon, GearIcon, SignOutIcon } from '@primer/octicons-react';
import type { User } from '../../shared/types';
import { basePath } from '../lib/api';

interface ShellProps {
  user: User;
  onSignOut: () => void;
  children: ReactNode;
}

export function Shell({ user, onSignOut, children }: ShellProps) {
  const navigate = useNavigate();

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-header-brand" href={`${basePath}/`}>
          <FileDiffIcon size={18} />
          <span>mureview</span>
        </a>
        <div className="app-header-actions">
          <span className="app-header-user">
            <Avatar src={user.avatarUrl} size={20} alt={user.name} />
            <span className="app-header-username">{user.name}</span>
          </span>
          <IconButton icon={GearIcon} aria-label="Settings" variant="invisible" onClick={() => navigate('/settings')} />
          <IconButton icon={SignOutIcon} aria-label="Sign out" variant="invisible" onClick={onSignOut} />
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
