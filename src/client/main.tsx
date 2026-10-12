import { createRoot } from 'react-dom/client';
import { BaseStyles, ThemeProvider } from '@primer/react';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider colorMode="auto">
    <BaseStyles>
      <App />
    </BaseStyles>
  </ThemeProvider>,
);
