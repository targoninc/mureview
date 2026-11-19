export type KeybindId = 'previous-file' | 'next-file' | 'submit-comment';

export interface KeybindDefinition {
  id: KeybindId;
  label: string;
  description: string;
  defaultCombo: string;
}

export const KEYBINDS: KeybindDefinition[] = [
  {
    id: 'previous-file',
    label: 'Previous file',
    description: 'Move to the previous file in the single-file view.',
    defaultCombo: 'Mod+Shift+ArrowUp',
  },
  {
    id: 'next-file',
    label: 'Next file',
    description: 'Move to the next file in the single-file view.',
    defaultCombo: 'Mod+Shift+ArrowDown',
  },
  {
    id: 'submit-comment',
    label: 'Submit comment',
    description: 'Send the focused review comment.',
    defaultCombo: 'Mod+Enter',
  },
];

export const DEFAULT_KEYBINDS = Object.fromEntries(KEYBINDS.map((keybind) => [keybind.id, keybind.defaultCombo])) as Record<
  KeybindId,
  string
>;

const modifiers = new Set(['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift']);
const modifierKeys = new Set(['Control', 'Meta', 'Alt', 'Shift']);

function normalizeKey(key: string): string | null {
  if (modifierKeys.has(key) || key === 'Dead' || key === 'Unidentified') return null;
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function keybindFor(overrides: Record<string, string> | null | undefined, id: KeybindId): string {
  const value = overrides?.[id]?.trim();
  return value || DEFAULT_KEYBINDS[id];
}

export function isValidKeybindCombo(combo: string): boolean {
  if (!combo || combo.length > 100 || combo.includes(' ')) return false;
  const parts = combo.split('+').map((part) => part.trim());
  if (parts.length < 2 || parts.includes('')) return false;
  const key = parts.pop()!;
  if (modifiers.has(key)) return false;
  if (parts.some((part) => !modifiers.has(part))) return false;
  if (new Set(parts).size !== parts.length) return false;
  if (parts.includes('Mod') && (parts.includes('Ctrl') || parts.includes('Meta'))) return false;
  return true;
}

export function comboFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  const key = normalizeKey(event.key);
  if (!key) return null;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function matchesKeybind(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  combo: string,
): boolean {
  if (!isValidKeybindCombo(combo)) return false;
  const parts = combo.split('+');
  const key = normalizeKey(event.key);
  if (!key || key !== parts.pop()) return false;
  const hasMod = parts.includes('Mod');
  const hasCtrl = parts.includes('Ctrl');
  const hasMeta = parts.includes('Meta');
  const hasAlt = parts.includes('Alt');
  const hasShift = parts.includes('Shift');
  if (hasMod) {
    if (!event.ctrlKey && !event.metaKey) return false;
  } else if (event.ctrlKey !== hasCtrl || event.metaKey !== hasMeta) {
    return false;
  }
  return event.altKey === hasAlt && event.shiftKey === hasShift;
}

export function keybindLabel(combo: string): string {
  return combo
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→');
}
