export interface MonoFontOption {
  id: string;
  label: string;
  /** CSS font-family value used for previews and the --font-mono variable. */
  family: string;
  /** Niche fonts are listed under "More fonts" in the settings. */
  niche?: boolean;
}

const SYSTEM_STACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

export const SYSTEM_MONO_FONT: MonoFontOption = { id: 'system', label: 'System default', family: SYSTEM_STACK };

export const MONO_FONTS: MonoFontOption[] = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: "'JetBrains Mono'" },
  { id: 'fira-code', label: 'Fira Code', family: "'Fira Code'" },
  { id: 'cascadia-code', label: 'Cascadia Code', family: "'Cascadia Code'" },
  { id: 'source-code-pro', label: 'Source Code Pro', family: "'Source Code Pro'" },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: "'IBM Plex Mono'" },
  { id: 'roboto-mono', label: 'Roboto Mono', family: "'Roboto Mono'" },
  { id: 'geist-mono', label: 'Geist Mono', family: "'Geist Mono'" },
  { id: 'hack', label: 'Hack', family: "'Hack'" },
  { id: 'inconsolata', label: 'Inconsolata', family: "'Inconsolata'" },
  { id: 'monaspace-neon', label: 'Monaspace Neon', family: "'Monaspace Neon'", niche: true },
  { id: 'victor-mono', label: 'Victor Mono', family: "'Victor Mono'", niche: true },
  { id: 'commit-mono', label: 'Commit Mono', family: "'Commit Mono'", niche: true },
  { id: 'iosevka', label: 'Iosevka', family: "'Iosevka'", niche: true },
  { id: 'intel-one-mono', label: 'Intel One Mono', family: "'Intel One Mono'", niche: true },
  { id: 'maple-mono', label: 'Maple Mono', family: "'Maple Mono'", niche: true },
  { id: 'atkinson-hyperlegible-mono', label: 'Atkinson Hyperlegible Mono', family: "'Atkinson Hyperlegible Mono'", niche: true },
  { id: 'martian-mono', label: 'Martian Mono', family: "'Martian Mono'", niche: true },
  { id: 'dm-mono', label: 'DM Mono', family: "'DM Mono'", niche: true },
  { id: 'red-hat-mono', label: 'Red Hat Mono', family: "'Red Hat Mono'", niche: true },
  { id: 'space-mono', label: 'Space Mono', family: "'Space Mono'", niche: true },
  { id: 'sometype-mono', label: 'Sometype Mono', family: "'Sometype Mono'", niche: true },
  { id: 'fragment-mono', label: 'Fragment Mono', family: "'Fragment Mono'", niche: true },
  { id: 'ubuntu-mono', label: 'Ubuntu Mono', family: "'Ubuntu Mono'", niche: true },
  { id: 'anonymous-pro', label: 'Anonymous Pro', family: "'Anonymous Pro'", niche: true },
];

export const DEFAULT_MONO_FONT = 'jetbrains-mono';

export const ALL_MONO_FONT_IDS = [...MONO_FONTS.map((font) => font.id), SYSTEM_MONO_FONT.id];

export function monoFontOption(id: string | null | undefined): MonoFontOption {
  if (id === SYSTEM_MONO_FONT.id) return SYSTEM_MONO_FONT;
  return MONO_FONTS.find((font) => font.id === id) ?? MONO_FONTS.find((font) => font.id === DEFAULT_MONO_FONT) ?? SYSTEM_MONO_FONT;
}

export function monoFontFamily(id: string | null | undefined): string {
  const font = monoFontOption(id);
  return font.id === SYSTEM_MONO_FONT.id ? SYSTEM_STACK : `${font.family}, ${SYSTEM_STACK}`;
}

/** The diff text sizes a user can pick, in pixels. */
export const DIFF_FONT_SIZES = [12, 13, 14, 15, 16, 17, 18, 19, 20];

export const DEFAULT_DIFF_FONT_SIZE = 15;

/** Keeps the diff line height in proportion to the text size. */
export function diffLineHeight(size: number): number {
  return Math.round((size * 22) / DEFAULT_DIFF_FONT_SIZE);
}
