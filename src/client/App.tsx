import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Spinner } from '@primer/react';
import type { MeResponse } from '../shared/types';
import { Shell } from './components/Shell';
import { Login } from './components/Login';
import { Dashboard } from './pages/Dashboard';
import { MergePage } from './pages/MergePage';
import { ReviewSetFormPage } from './pages/ReviewSetFormPage';
import { ReviewSetPage } from './pages/ReviewSetPage';
import { SettingsPage } from './pages/SettingsPage';
import { api, basename, post } from './lib/api';
import { AppContext } from './lib/appContext';

export function App() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    api<MeResponse>('/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const signOut = useCallback(() => {
    post('/auth/logout', {}).catch(() => undefined);
    setMe((current) => (current ? { ...current, user: null, identities: [], connections: [] } : current));
  }, []);

  if (loading) {
    return (
      <div className="centered">
        <Spinner size="large" aria-label="Loading" />
      </div>
    );
  }

  if (!me?.user) return <Login providers={me?.providers ?? ['email']} onSignedIn={refresh} />;

  return (
    <AppContext.Provider value={{ githubOAuthAppUrl: me.githubOAuthAppUrl, user: me.user }}>
      <BrowserRouter basename={basename}>
        <Shell user={me.user} onSignOut={signOut}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/review-sets/new" element={<ReviewSetFormPage />} />
            <Route path="/review-sets/:id" element={<ReviewSetPage />} />
            <Route path="/review-sets/:id/settings" element={<ReviewSetFormPage />} />
            <Route path="/review-sets/:id/merge" element={<MergePage />} />
            <Route path="*" element={<div className="empty-state">Page not found.</div>} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AppContext.Provider>
  );
}
