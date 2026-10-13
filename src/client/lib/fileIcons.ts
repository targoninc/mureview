import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees';

/**
 * The file icons T3 Code uses: the colored "complete" set from
 * @pierre/trees. The sprite is injected into the document once and the
 * resolver maps a file path to its icon symbol and colour.
 */
const resolver = createFileTreeIconResolver({ set: 'complete', colored: true });
let spriteInjected = false;

export function ensureFileIconSprite(): void {
  if (spriteInjected || typeof document === 'undefined') return;
  spriteInjected = true;
  const holder = document.createElement('div');
  holder.style.display = 'none';
  holder.innerHTML = getBuiltInSpriteSheet('complete');
  document.body.appendChild(holder);
}

/** Colours per icon token, as used by the tree's own stylesheet. */
const tokenColors: Record<string, string> = {
  default: 'var(--trees-icon-gray)',
  text: 'var(--trees-icon-gray)',
  astro: 'var(--trees-icon-purple)',
  babel: 'var(--trees-icon-yellow)',
  bash: 'var(--trees-icon-green)',
  biome: 'var(--trees-icon-blue)',
  bootstrap: 'var(--trees-icon-indigo)',
  browserslist: 'var(--trees-icon-yellow)',
  bun: 'var(--trees-icon-mauve)',
  c: 'var(--trees-icon-blue)',
  cpp: 'var(--trees-icon-blue)',
  claude: 'var(--trees-icon-orange)',
  css: 'var(--trees-icon-indigo)',
  database: 'var(--trees-icon-purple)',
  docker: 'var(--trees-icon-blue)',
  eslint: 'var(--trees-icon-indigo)',
  git: 'var(--trees-icon-vermilion)',
  go: 'var(--trees-icon-cyan)',
  graphql: 'var(--trees-icon-pink)',
  html: 'var(--trees-icon-orange)',
  image: 'var(--trees-icon-pink)',
  javascript: 'var(--trees-icon-yellow)',
  json: 'var(--trees-icon-orange)',
  markdown: 'var(--trees-icon-green)',
  mcp: 'var(--trees-icon-teal)',
  npm: 'var(--trees-icon-red)',
  oxc: 'var(--trees-icon-cyan)',
  postcss: 'var(--trees-icon-red)',
  prettier: 'var(--trees-icon-teal)',
  python: 'var(--trees-icon-blue)',
  react: 'var(--trees-icon-cyan)',
  ruby: 'var(--trees-icon-red)',
  rust: 'var(--trees-icon-orange)',
  sass: 'var(--trees-icon-pink)',
  svg: 'var(--trees-icon-orange)',
  svelte: 'var(--trees-icon-red)',
  svgo: 'var(--trees-icon-green)',
  swift: 'var(--trees-icon-orange)',
  table: 'var(--trees-icon-teal)',
  tailwind: 'var(--trees-icon-cyan)',
  terraform: 'var(--trees-icon-indigo)',
  typescript: 'var(--trees-icon-blue)',
  vite: 'var(--trees-icon-purple)',
  vscode: 'var(--trees-icon-blue)',
  vue: 'var(--trees-icon-green)',
  wasm: 'var(--trees-icon-indigo)',
  webpack: 'var(--trees-icon-blue)',
  yml: 'var(--trees-icon-red)',
  zig: 'var(--trees-icon-orange)',
  zip: 'var(--trees-icon-orange)',
};

export interface FileIcon {
  name: string;
  color: string;
}

/** The icon symbol and colour for a file path. */
export function fileIconFor(path: string): FileIcon {
  const icon = resolver.resolveIcon('file-tree-icon-file', path);
  return { name: icon.name, color: tokenColors[icon.token ?? 'default'] ?? tokenColors.default };
}
