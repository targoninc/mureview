import { createContext, useContext } from 'react';

export interface AppContextValue {
  githubOAuthAppUrl: string | null;
}

export const AppContext = createContext<AppContextValue>({ githubOAuthAppUrl: null });

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
