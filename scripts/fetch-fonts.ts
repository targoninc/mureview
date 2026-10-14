/**
 * Downloads the bundled monospace fonts (woff2, latin + latin-ext) and their
 * license texts. Run with `bun run scripts/fetch-fonts.ts` after changing the
 * list below; the app itself never loads fonts from external URLs.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FONT_DIR = join(ROOT, 'src/client/fonts');
const LICENSE_DIR = join(ROOT, 'public/fonts/licenses');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const SUBSETS = new Set(['latin', 'latin-ext']);
const SUBSET_RANGES: Record<string, string> = {
  latin:
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
  'latin-ext':
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF',
};

interface GoogleFamily {
  source: 'google';
  id: string;
  label: string;
  css: string;
  dir: string;
}

interface FontsourceFamily {
  source: 'fontsource';
  id: string;
  label: string;
  pkg: string;
  version: string;
  licenseUrl?: string;
}

interface HackFamily {
  source: 'hack';
  id: string;
  label: string;
}

type Family = GoogleFamily | FontsourceFamily | HackFamily;

const families: Family[] = [
  { source: 'google', id: 'jetbrains-mono', label: 'JetBrains Mono', css: 'JetBrains+Mono', dir: 'ofl/jetbrainsmono' },
  { source: 'google', id: 'fira-code', label: 'Fira Code', css: 'Fira+Code', dir: 'ofl/firacode' },
  { source: 'google', id: 'cascadia-code', label: 'Cascadia Code', css: 'Cascadia+Code', dir: 'ofl/cascadiacode' },
  { source: 'google', id: 'source-code-pro', label: 'Source Code Pro', css: 'Source+Code+Pro', dir: 'ofl/sourcecodepro' },
  { source: 'google', id: 'ibm-plex-mono', label: 'IBM Plex Mono', css: 'IBM+Plex+Mono', dir: 'ofl/ibmplexmono' },
  { source: 'google', id: 'roboto-mono', label: 'Roboto Mono', css: 'Roboto+Mono', dir: 'ofl/robotomono' },
  { source: 'google', id: 'geist-mono', label: 'Geist Mono', css: 'Geist+Mono', dir: 'ofl/geistmono' },
  { source: 'google', id: 'inconsolata', label: 'Inconsolata', css: 'Inconsolata', dir: 'ofl/inconsolata' },
  { source: 'google', id: 'atkinson-hyperlegible-mono', label: 'Atkinson Hyperlegible Mono', css: 'Atkinson+Hyperlegible+Mono', dir: 'ofl/atkinsonhyperlegiblemono' },
  { source: 'google', id: 'martian-mono', label: 'Martian Mono', css: 'Martian+Mono', dir: 'ofl/martianmono' },
  { source: 'google', id: 'dm-mono', label: 'DM Mono', css: 'DM+Mono', dir: 'ofl/dmmono' },
  { source: 'google', id: 'red-hat-mono', label: 'Red Hat Mono', css: 'Red+Hat+Mono', dir: 'ofl/redhatmono' },
  { source: 'google', id: 'space-mono', label: 'Space Mono', css: 'Space+Mono', dir: 'ofl/spacemono' },
  { source: 'google', id: 'sometype-mono', label: 'Sometype Mono', css: 'Sometype+Mono', dir: 'ofl/sometypemono' },
  { source: 'google', id: 'fragment-mono', label: 'Fragment Mono', css: 'Fragment+Mono', dir: 'ofl/fragmentmono' },
  { source: 'google', id: 'ubuntu-mono', label: 'Ubuntu Mono', css: 'Ubuntu+Mono', dir: 'ufl/ubuntumono' },
  { source: 'google', id: 'anonymous-pro', label: 'Anonymous Pro', css: 'Anonymous+Pro', dir: 'ofl/anonymouspro' },
  { source: 'hack', id: 'hack', label: 'Hack' },
  { source: 'fontsource', id: 'monaspace-neon', label: 'Monaspace Neon', pkg: 'monaspace-neon', version: '5.3.0' },
  { source: 'fontsource', id: 'victor-mono', label: 'Victor Mono', pkg: 'victor-mono', version: '5.3.0' },
  {
    source: 'fontsource',
    id: 'commit-mono',
    label: 'Commit Mono',
    pkg: 'commit-mono',
    version: '5.3.0',
    licenseUrl: 'https://raw.githubusercontent.com/eigilnikolajsen/commit-mono/main/LICENSE',
  },
  { source: 'fontsource', id: 'iosevka', label: 'Iosevka', pkg: 'iosevka', version: '5.3.0' },
  { source: 'fontsource', id: 'intel-one-mono', label: 'Intel One Mono', pkg: 'intel-one-mono', version: '5.3.0' },
  { source: 'fontsource', id: 'maple-mono', label: 'Maple Mono', pkg: 'maple-mono', version: '5.3.0' },
];

const report: string[] = [];
const rules: string[] = [];
let totalBytes = 0;

async function download(url: string): Promise<Uint8Array | null> {
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

function rule(label: string, style: string, weight: string, file: string, range: string): string {
  return [
    `@font-face {`,
    `  font-family: '${label}';`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    `  font-display: swap;`,
    `  src: url('./${file}') format('woff2');`,
    `  unicode-range: ${range.trim()};`,
    `}`,
  ].join('\n');
}

async function saveFont(id: string, name: string, bytes: Uint8Array): Promise<string> {
  await writeFile(join(FONT_DIR, id, name), bytes);
  totalBytes += bytes.byteLength;
  return `${id}/${name}`;
}

async function fetchGoogle(family: GoogleFamily): Promise<void> {
  let css: string | null = null;
  for (const styles of ['ital,wght@0,400;0,700;1,400', 'wght@400;700']) {
    const response = await fetch(`https://fonts.googleapis.com/css2?family=${family.css}:${styles}&display=swap`, {
      headers: { 'User-Agent': UA },
    });
    if (response.ok) {
      css = await response.text();
      break;
    }
  }
  if (!css) throw new Error(`${family.id}: no CSS from Google Fonts`);
  await mkdir(join(FONT_DIR, family.id), { recursive: true });

  let files = 0;
  for (const [, subset, body] of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g)) {
    if (!SUBSETS.has(subset)) continue;
    const style = /font-style:\s*(\w+)/.exec(body)?.[1] ?? 'normal';
    const weight = /font-weight:\s*(\d+)/.exec(body)?.[1] ?? '400';
    const url = /src:\s*url\(([^)]+)\)/.exec(body)?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
    if (!url || !range) continue;
    const bytes = await download(url);
    if (!bytes) {
      report.push(`${family.id}: missing ${subset} ${weight} ${style}`);
      continue;
    }
    const file = await saveFont(family.id, `${subset}-${weight}-${style}.woff2`, bytes);
    rules.push(rule(family.label, style, weight, file, range));
    files += 1;
  }
  report.push(`${family.id}: ${files} files`);
}

async function fetchFontsource(family: FontsourceFamily): Promise<void> {
  await mkdir(join(FONT_DIR, family.id), { recursive: true });
  let files = 0;
  for (const [sheet, style, weight] of [
    ['400.css', 'normal', '400'],
    ['700.css', 'normal', '700'],
    ['400-italic.css', 'italic', '400'],
  ] as const) {
    const url = `https://cdn.jsdelivr.net/npm/@fontsource/${family.pkg}@${family.version}/${sheet}`;
    const response = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!response.ok) {
      report.push(`${family.id}: no ${sheet}`);
      continue;
    }
    const css = await response.text();
    for (const [, body] of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const src = /url\(([^)]+)\)/.exec(body)?.[1];
      if (!src) continue;
      const name = src.split('/').pop() ?? '';
      const subset = name.includes('-latin-ext-') ? 'latin-ext' : name.includes('-latin-') ? 'latin' : null;
      if (!subset) continue;
      const range = /unicode-range:\s*([^;]+);/.exec(body)?.[1] ?? SUBSET_RANGES[subset];
      const bytes = await download(new URL(src, url).href);
      if (!bytes) continue;
      const file = await saveFont(family.id, name, bytes);
      rules.push(rule(family.label, style, weight, file, range));
      files += 1;
    }
  }
  report.push(`${family.id}: ${files} files`);
}

async function fetchHack(family: HackFamily): Promise<void> {
  await mkdir(join(FONT_DIR, family.id), { recursive: true });
  const files: Array<[string, string, string, string]> = [
    ['hack-regular.woff2', '400-normal.woff2', 'normal', '400'],
    ['hack-bold.woff2', '700-normal.woff2', 'normal', '700'],
    ['hack-italic.woff2', '400-italic.woff2', 'italic', '400'],
  ];
  for (const [from, to, style, weight] of files) {
    const bytes = await download(`https://cdn.jsdelivr.net/npm/hack-font@3.3.0/build/web/fonts/${from}`);
    if (!bytes) throw new Error(`${family.id}: missing ${from}`);
    await saveFont(family.id, to, bytes);
    rules.push(rule(family.label, style, weight, `${family.id}/${to}`, 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC, U+2122, U+2190-21BB, U+2212, U+2215, U+FEFF, U+FFFD'));
  }
  report.push(`${family.id}: ${files.length} files`);
}

async function fetchLicense(family: Family): Promise<void> {
  const candidates =
    family.source === 'google'
      ? [`https://raw.githubusercontent.com/google/fonts/main/${family.dir}/OFL.txt`, `https://raw.githubusercontent.com/google/fonts/main/${family.dir}/LICENSE.txt`, `https://raw.githubusercontent.com/google/fonts/main/${family.dir}/UFL.txt`]
      : family.source === 'fontsource'
        ? [
            `https://cdn.jsdelivr.net/npm/@fontsource/${family.pkg}@${family.version}/LICENSE`,
            ...(family.licenseUrl ? [family.licenseUrl] : []),
          ]
        : ['https://raw.githubusercontent.com/source-foundry/Hack/master/LICENSE.md'];
  for (const url of candidates) {
    const response = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!response.ok) continue;
    await writeFile(join(LICENSE_DIR, `${family.id}.txt`), await response.text());
    return;
  }
  report.push(`${family.id}: license not found`);
}

await rm(FONT_DIR, { recursive: true, force: true });
await rm(LICENSE_DIR, { recursive: true, force: true });
await mkdir(LICENSE_DIR, { recursive: true });

for (const family of families) {
  try {
    if (family.source === 'google') await fetchGoogle(family);
    else if (family.source === 'fontsource') await fetchFontsource(family);
    else await fetchHack(family);
    await fetchLicense(family);
  } catch (error) {
    report.push(`${family.id}: FAILED ${(error as Error).message}`);
  }
}

const header = '/* Bundled monospace fonts, generated by scripts/fetch-fonts.ts. Licenses live in public/fonts/licenses. */\n\n';
await writeFile(join(FONT_DIR, 'fonts.css'), header + rules.join('\n\n') + '\n');
console.log(report.join('\n'));
console.log(`total ${(totalBytes / 1024 / 1024).toFixed(2)} MB across ${rules.length} @font-face rules`);
