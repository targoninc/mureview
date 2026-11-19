import { useRef, useState } from 'react';
import { Button, Spinner } from '@primer/react';
import { KEYBINDS, comboFromEvent, isValidKeybindCombo, keybindFor, keybindLabel } from '../../shared/keybinds';

function KeybindRecorder({
  combo,
  disabled,
  onChange,
  onInvalid,
}: {
  combo: string;
  disabled: boolean;
  onChange: (combo: string) => void;
  onInvalid: (message: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <Button
      ref={buttonRef}
      size="small"
      variant={recording ? 'primary' : 'default'}
      disabled={disabled}
      onBlur={() => setRecording(false)}
      onClick={() => {
        setRecording(true);
        buttonRef.current?.focus();
      }}
      onKeyDown={(event) => {
        if (!recording) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          setRecording(false);
          return;
        }
        const next = comboFromEvent(event);
        if (!next) return;
        if (!isValidKeybindCombo(next)) {
          onInvalid(`"${next}" is not a valid shortcut.`);
          setRecording(false);
          return;
        }
        setRecording(false);
        onChange(next);
      }}
    >
      {recording ? 'Press keys…' : keybindLabel(combo)}
    </Button>
  );
}

export function KeybindSettings({
  keybinds,
  saving,
  error,
  onChange,
  onReset,
  onResetAll,
}: {
  keybinds: Record<string, string>;
  saving: boolean;
  error: string | null;
  onChange: (id: string, combo: string) => void;
  onReset: (id: string) => void;
  onResetAll: () => void;
}) {
  const [localError, setLocalError] = useState<string | null>(null);
  const custom = Object.keys(keybinds).length > 0;
  const shownError = error ?? localError;
  return (
    <div className="settings-panel stack" style={{ gap: 0 }}>
      {shownError ? (
        <div style={{ padding: '8px 16px' }}>
          <span style={{ color: 'var(--fgColor-danger)', fontSize: 12 }}>{shownError}</span>
        </div>
      ) : null}
      {KEYBINDS.map((keybind) => {
        const combo = keybindFor(keybinds, keybind.id);
        return (
          <div className="keybind-row" key={keybind.id}>
            <div className="stack" style={{ gap: 3 }}>
              <strong style={{ fontSize: 13 }}>{keybind.label}</strong>
              <span style={{ fontSize: 12, color: 'var(--fgColor-muted)' }}>{keybind.description}</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <KeybindRecorder
                combo={combo}
                disabled={saving}
                onChange={(next) => {
                  setLocalError(null);
                  onChange(keybind.id, next);
                }}
                onInvalid={(message) => setLocalError(message)}
              />
              <Button size="small" variant="invisible" disabled={saving || combo === keybind.defaultCombo} onClick={() => {
                  setLocalError(null);
                  onReset(keybind.id);
                }}>
                Reset
              </Button>
            </div>
          </div>
        );
      })}
      <div className="row" style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '12px 16px' }}>
        <div className="row" style={{ gap: 8 }}>
          {saving ? <Spinner size="small" aria-label="Saving shortcuts" /> : null}
          <Button size="small" disabled={saving || !custom} onClick={() => {
            setLocalError(null);
            onResetAll();
          }}>
            Restore all defaults
          </Button>
        </div>
      </div>
    </div>
  );
}
