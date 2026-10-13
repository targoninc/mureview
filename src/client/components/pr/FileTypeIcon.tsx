import {
  siAstro,
  siC,
  siClojure,
  siCmake,
  siCoffeescript,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siDotnet,
  siElixir,
  siErlang,
  siFsharp,
  siGit,
  siGnubash,
  siGo,
  siGradle,
  siGraphql,
  siHaskell,
  siHtml5,
  siJson,
  siJulia,
  siJupyter,
  siKotlin,
  siLatex,
  siLess,
  siLua,
  siMake,
  siMarkdown,
  siNim,
  siOcaml,
  siOpenjdk,
  siPerl,
  siPhp,
  siPrisma,
  siPython,
  siR,
  siRuby,
  siRust,
  siSass,
  siScala,
  siSolidity,
  siStylus,
  siSvelte,
  siSwift,
  siTerraform,
  siToml,
  siTypescript,
  siVuedotjs,
  siWebassembly,
  siYaml,
  siZig,
  siJavascript,
} from 'simple-icons';
import { DatabaseIcon, FileBinaryIcon, FileIcon, FileMediaIcon, FileZipIcon, TerminalIcon } from '@primer/octicons-react';

interface SimpleIcon {
  path: string;
  title: string;
}

const byExtension: Record<string, SimpleIcon> = {
  ts: siTypescript,
  mts: siTypescript,
  cts: siTypescript,
  tsx: siTypescript,
  js: siJavascript,
  mjs: siJavascript,
  cjs: siJavascript,
  jsx: siJavascript,
  py: siPython,
  pyi: siPython,
  rb: siRuby,
  go: siGo,
  rs: siRust,
  java: siOpenjdk,
  kt: siKotlin,
  kts: siKotlin,
  c: siC,
  h: siC,
  cpp: siCplusplus,
  cc: siCplusplus,
  cxx: siCplusplus,
  hpp: siCplusplus,
  hh: siCplusplus,
  cs: siDotnet,
  php: siPhp,
  swift: siSwift,
  dart: siDart,
  scala: siScala,
  ex: siElixir,
  exs: siElixir,
  hs: siHaskell,
  lua: siLua,
  r: siR,
  pl: siPerl,
  pm: siPerl,
  clj: siClojure,
  cljs: siClojure,
  ml: siOcaml,
  mli: siOcaml,
  fs: siFsharp,
  fsx: siFsharp,
  jl: siJulia,
  nim: siNim,
  zig: siZig,
  sol: siSolidity,
  erl: siErlang,
  hrl: siErlang,
  coffee: siCoffeescript,
  graphql: siGraphql,
  gql: siGraphql,
  prisma: siPrisma,
  html: siHtml5,
  htm: siHtml5,
  css: siCss,
  scss: siSass,
  sass: siSass,
  less: siLess,
  styl: siStylus,
  vue: siVuedotjs,
  svelte: siSvelte,
  astro: siAstro,
  md: siMarkdown,
  mdx: siMarkdown,
  yml: siYaml,
  yaml: siYaml,
  json: siJson,
  jsonc: siJson,
  toml: siToml,
  sh: siGnubash,
  bash: siGnubash,
  zsh: siGnubash,
  tex: siLatex,
  cmake: siCmake,
  gradle: siGradle,
  tf: siTerraform,
  ipynb: siJupyter,
  wasm: siWebassembly,
  wat: siWebassembly,
};

const byFilename: Record<string, SimpleIcon> = {
  dockerfile: siDocker,
  makefile: siMake,
  gnumakefile: siMake,
  'cmakelists.txt': siCmake,
  '.gitignore': siGit,
  '.gitattributes': siGit,
  '.gitmodules': siGit,
};

const octicons: Record<string, { icon: typeof FileIcon; title: string }> = {
  sql: { icon: DatabaseIcon, title: 'Database' },
  ps1: { icon: TerminalIcon, title: 'Terminal' },
  bat: { icon: TerminalIcon, title: 'Terminal' },
  cmd: { icon: TerminalIcon, title: 'Terminal' },
  png: { icon: FileMediaIcon, title: 'Image' },
  jpg: { icon: FileMediaIcon, title: 'Image' },
  jpeg: { icon: FileMediaIcon, title: 'Image' },
  gif: { icon: FileMediaIcon, title: 'Image' },
  svg: { icon: FileMediaIcon, title: 'Image' },
  webp: { icon: FileMediaIcon, title: 'Image' },
  ico: { icon: FileMediaIcon, title: 'Image' },
  bmp: { icon: FileMediaIcon, title: 'Image' },
  avif: { icon: FileMediaIcon, title: 'Image' },
  mp3: { icon: FileMediaIcon, title: 'Media' },
  mp4: { icon: FileMediaIcon, title: 'Media' },
  webm: { icon: FileMediaIcon, title: 'Media' },
  zip: { icon: FileZipIcon, title: 'Archive' },
  gz: { icon: FileZipIcon, title: 'Archive' },
  tgz: { icon: FileZipIcon, title: 'Archive' },
  tar: { icon: FileZipIcon, title: 'Archive' },
  '7z': { icon: FileZipIcon, title: 'Archive' },
  rar: { icon: FileZipIcon, title: 'Archive' },
  bz2: { icon: FileZipIcon, title: 'Archive' },
  xz: { icon: FileZipIcon, title: 'Archive' },
  exe: { icon: FileBinaryIcon, title: 'Binary' },
  dll: { icon: FileBinaryIcon, title: 'Binary' },
  so: { icon: FileBinaryIcon, title: 'Binary' },
  dylib: { icon: FileBinaryIcon, title: 'Binary' },
  class: { icon: FileBinaryIcon, title: 'Binary' },
  jar: { icon: FileBinaryIcon, title: 'Binary' },
  o: { icon: FileBinaryIcon, title: 'Binary' },
  a: { icon: FileBinaryIcon, title: 'Binary' },
  bin: { icon: FileBinaryIcon, title: 'Binary' },
};

/** The file tree icon for a file, based on its name and extension. */
export function FileTypeIcon({ name, path, size = 14 }: { name: string; path: string; size?: number }) {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const simple = byFilename[name.toLowerCase()] ?? byExtension[extension];
  if (simple) {
    return (
      <span className="service-icon" role="img" aria-label={simple.title} title={simple.title}>
        <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
          <path d={simple.path} />
        </svg>
      </span>
    );
  }
  const octicon = octicons[extension];
  if (octicon) {
    const Icon = octicon.icon;
    return (
      <span className="service-icon" role="img" aria-label={octicon.title} title={octicon.title}>
        <Icon size={size} />
      </span>
    );
  }
  return <FileIcon size={size} />;
}
