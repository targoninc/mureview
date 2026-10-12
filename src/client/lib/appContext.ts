import { createContext, useContext } from 'react';

export interface AppContextValue {
  oauthAppUrl: string | null;
}

export const AppContext = createContext<AppContextValue>({ oauthAppUrl: null });

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
