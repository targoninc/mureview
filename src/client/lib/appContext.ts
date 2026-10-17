import { createContext, useContext } from 'react';
import type { User } from '../../shared/types';

export interface AppContextValue {
  githubOAuthAppUrl: string | null;
  user: User | null;
  /** Update the signed-in user's own fields after a settings change. */
  updateUser: (patch: Partial<User>) => void;
}

export const AppContext = createContext<AppContextValue>({
  githubOAuthAppUrl: null,
  user: null,
  updateUser: () => undefined,
});

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
