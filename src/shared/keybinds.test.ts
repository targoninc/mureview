import { describe, expect, test } from 'bun:test';
import { comboFromEvent, isValidKeybindCombo, keybindFor, matchesKeybind } from './keybinds';

function key(key: string, modifiers: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers };
}

describe('keybind matching', () => {
  test('Mod matches Ctrl and Meta without requiring the other', () => {
    expect(matchesKeybind(key('ArrowUp', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+ArrowUp')).toBe(true);
    expect(matchesKeybind(key('ArrowUp', { metaKey: true, shiftKey: true }), 'Mod+Shift+ArrowUp')).toBe(true);
    expect(matchesKeybind(key('ArrowUp', { ctrlKey: true }), 'Mod+Shift+ArrowUp')).toBe(false);
  });

  test('custom modifiers are exact', () => {
    expect(matchesKeybind(key('p', { ctrlKey: true, altKey: true }), 'Ctrl+Alt+P')).toBe(true);
    expect(matchesKeybind(key('p', { metaKey: true, altKey: true }), 'Ctrl+Alt+P')).toBe(false);
  });
});

describe('keybind capture', () => {
  test('records modifiers in a stable order', () => {
    expect(comboFromEvent(key('ArrowUp', { metaKey: true, shiftKey: true }))).toBe('Mod+Shift+ArrowUp');
    expect(comboFromEvent(key('Enter', { metaKey: true }))).toBe('Mod+Enter');
  });

  test('ignores modifier-only presses', () => {
    expect(comboFromEvent(key('Shift', { shiftKey: true }))).toBeNull();
  });

  test('validates stored combinations and falls back to defaults', () => {
    expect(isValidKeybindCombo('Mod+Enter')).toBe(true);
    expect(isValidKeybindCombo('Shift')).toBe(false);
    expect(keybindFor({}, 'next-file')).toBe('Mod+Shift+ArrowDown');
  });
});
