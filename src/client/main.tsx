import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@primer/react';
import '@primer/primitives/dist/css/base/motion/motion.css';
import '@primer/primitives/dist/css/base/size/size.css';
import '@primer/primitives/dist/css/base/typography/typography.css';
import '@primer/primitives/dist/css/functional/themes/light.css';
import '@primer/primitives/dist/css/functional/themes/dark.css';
import './fonts/fonts.css';
import './styles.css';
import { App } from './App';

const html = document.documentElement;
html.setAttribute('data-color-mode', 'dark');
html.setAttribute('data-light-theme', 'light');
html.setAttribute('data-dark-theme', 'dark');

createRoot(document.getElementById('root')!).render(
  <ThemeProvider colorMode="night" nightScheme="dark" contextOnly>
    <App />
  </ThemeProvider>,
);
