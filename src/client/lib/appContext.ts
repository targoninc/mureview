import { createContext, useContext } from 'react';
import type { User } from '../../shared/types';

export interface AppContextValue {
  githubOAuthAppUrl: string | null;
  user: User | null;
}

export const AppContext = createContext<AppContextValue>({ githubOAuthAppUrl: null, user: null });

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
