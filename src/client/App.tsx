import { useCallback, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Spinner } from '@primer/react';
import type { User } from '../shared/types';
import { Shell } from './components/Shell';
import { Login } from './components/Login';
import { Dashboard } from './pages/Dashboard';
import { ReviewSetFormPage } from './pages/ReviewSetFormPage';
import { ReviewSetPage } from './pages/ReviewSetPage';
import { api, basename, post } from './lib/api';
import { AppContext } from './lib/appContext';

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [oauthAppUrl, setOauthAppUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: User | null; oauthAppUrl: string | null }>('/me')
      .then((result) => {
        setUser(result.user);
        setOauthAppUrl(result.oauthAppUrl);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const signOut = useCallback(() => {
    post('/auth/logout', {}).catch(() => undefined);
    setUser(null);
  }, []);

  if (loading) {
    return (
      <div className="centered">
        <Spinner size="large" aria-label="Loading" />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <AppContext.Provider value={{ oauthAppUrl }}>
      <BrowserRouter basename={basename}>
        <Shell user={user} onSignOut={signOut}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/review-sets/new" element={<ReviewSetFormPage />} />
            <Route path="/review-sets/:id" element={<ReviewSetPage />} />
            <Route path="/review-sets/:id/settings" element={<ReviewSetFormPage />} />
            <Route path="*" element={<div className="empty-state">Page not found.</div>} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AppContext.Provider>
  );
}
