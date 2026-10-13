import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar, IconButton, useConfirm } from '@primer/react';
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
  const confirm = useConfirm();
  const builtAt = new Date(__BUILD_TIME__).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  const signOut = async () => {
    const approved = await confirm({
      title: 'Sign out of mureview?',
      content: 'You can sign back in with any of your connected accounts. Nothing on the forges is touched.',
      confirmButtonContent: 'Sign out',
      cancelButtonContent: 'Cancel',
    });
    if (approved) onSignOut();
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-left">
          <a className="app-header-brand" href={`${basePath}/`}>
            <FileDiffIcon size={18} />
            <span>mureview</span>
          </a>
          <span className="app-header-build" title="When this build was created">
            built {builtAt}
          </span>
        </div>
        <div className="app-header-actions">
          <span className="app-header-user">
            <Avatar src={user.avatarUrl} size={20} alt={user.name} />
            <span className="app-header-username">{user.name}</span>
          </span>
          <IconButton icon={GearIcon} aria-label="Settings" variant="invisible" onClick={() => navigate('/settings')} />
          <IconButton icon={SignOutIcon} aria-label="Sign out" variant="invisible" onClick={signOut} />
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
