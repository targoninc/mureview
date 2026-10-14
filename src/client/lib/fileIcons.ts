import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees';

/**
 * Icons the built-in set is missing. Each symbol is appended to the injected
 * sprite and mapped below; the C# mark is the MIT-licensed one from
 * vscode-material-icon-theme, without its fill so the themed colour applies.
 */
const customSymbols = `
  <symbol id="mureview-icon-csharp" viewBox="0 0 32 32"><path d="M30 14v-2h-2V8h-2v4h-2V8h-2v4h-2v2h2v2h-2v2h2v4h2v-4h2v4h2v-4h2v-2h-2v-2Zm-4 2h-2v-2h2Zm-12.437 6A5.57 5.57 0 0 1 8 16.437v-2.873A5.57 5.57 0 0 1 13.563 8H18V2h-4.437A11.563 11.563 0 0 0 2 13.563v2.873A11.564 11.564 0 0 0 13.563 28H18v-6Z"/></symbol>
`;

const customColors: Record<string, string> = {
  'mureview-icon-csharp': 'var(--trees-icon-purple)',
};

/**
 * The file icons T3 Code uses: the colored "complete" set from
 * @pierre/trees. The sprite is injected into the document once and the
 * resolver maps a file path to its icon symbol and colour.
 */
const resolver = createFileTreeIconResolver({
  set: 'complete',
  colored: true,
  // The complete set knows no C#; .cs (and its script variant) get its mark.
  byFileExtension: {
    cs: { name: 'mureview-icon-csharp' },
    csx: { name: 'mureview-icon-csharp' },
  },
});
let spriteInjected = false;

export function ensureFileIconSprite(): void {
  if (spriteInjected || typeof document === 'undefined') return;
  spriteInjected = true;
  const holder = document.createElement('div');
  holder.style.display = 'none';
  holder.innerHTML = getBuiltInSpriteSheet('complete').replace('</svg>', `${customSymbols}</svg>`);
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
  const color = icon.token
    ? (tokenColors[icon.token] ?? tokenColors.default)
    : (customColors[icon.name] ?? tokenColors.default);
  return { name: icon.name, color };
}
