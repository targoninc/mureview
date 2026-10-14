import { useMemo, useState, type CSSProperties } from 'react';
import { processFile } from '@pierre/diffs';
import { CodeView, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { Button, Dialog, TextInput } from '@primer/react';
import { CheckIcon, SearchIcon } from '@primer/octicons-react';
import { MONO_FONTS, SYSTEM_MONO_FONT, monoFontFamily, monoFontOption, type MonoFontOption } from '../../shared/fonts';

const SAMPLE_PATCH = `--- a/src/server/totals.ts
+++ b/src/server/totals.ts
@@ -1,8 +1,10 @@
 import { Item } from './types';
 
 export function total(items: Item[]): number {
-  return items.reduce((sum, item) => sum + item.price, 0);
+  const sum = items.reduce((acc, item) => acc + item.price, 0);
+  // Round to cents before applying the discount
+  const discount = sum > 100 ? 0.1 : 0;
+  const total = sum * (1 - discount);
+  return Number(total.toFixed(2));
 }
 
 export const items: Item[] = [{ name: 'Album', price: 12.5 }];
`;

const previewDiff = processFile(SAMPLE_PATCH, { cacheKey: 'font-preview' });

const previewOptions: CodeViewReactOptions<undefined, undefined> = {
  theme: { dark: 'pierre-dark', light: 'pierre-light' },
  themeType: 'dark',
  diffStyle: window.localStorage.getItem('mureview:diff-style') === 'split' ? 'split' : 'unified',
  stickyHeaders: true,
  hunkSeparators: 'line-info',
  itemMetrics: { lineHeight: 22 },
  layout: { paddingTop: 8, paddingBottom: 24, gap: 8 },
};

export function FontPickerDialog({
  current,
  saving,
  onClose,
  onPick,
}: {
  current: string;
  saving: boolean;
  onClose: () => void;
  onPick: (font: MonoFontOption) => void;
}) {
  const [search, setSearch] = useState('');
  const [previewId, setPreviewId] = useState(current);

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matches = (font: MonoFontOption) => !needle || font.label.toLowerCase().includes(needle);
    return [
      { label: 'Common', fonts: MONO_FONTS.filter((font) => !font.niche && matches(font)) },
      { label: 'More fonts', fonts: MONO_FONTS.filter((font) => font.niche && matches(font)) },
      { label: 'Fallback', fonts: [SYSTEM_MONO_FONT].filter(matches) },
    ].filter((group) => group.fonts.length > 0);
  }, [search]);

  const preview = monoFontOption(previewId);
  const previewFamily = monoFontFamily(preview.id);
  const items: CodeViewItem<undefined>[] = previewDiff ? [{ id: 'font-preview', type: 'diff', fileDiff: previewDiff }] : [];

  return (
    <Dialog
      title="Monospace font"
      width="90vw"
      height="auto"
      onClose={onClose}
      footerButtons={[
        { content: 'Close', onClick: onClose, buttonType: 'default' },
        {
          content: 'Use this font',
          onClick: () => onPick(preview),
          disabled: saving || preview.id === current,
          buttonType: 'primary',
        },
      ]}
    >
      <div className="font-picker">
        <div className="font-picker-list">
          <TextInput
            block
            leadingVisual={SearchIcon}
            placeholder="Search fonts"
            aria-label="Search fonts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="font-picker-scroll">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="font-picker-group">{group.label}</div>
                {group.fonts.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    className="font-picker-item"
                    aria-pressed={font.id === current}
                    data-preview={font.id === preview.id ? 'true' : undefined}
                    onMouseEnter={() => setPreviewId(font.id)}
                    onFocus={() => setPreviewId(font.id)}
                    onClick={() => setPreviewId(font.id)}
                  >
                    <span className="font-picker-check">{font.id === current ? <CheckIcon /> : null}</span>
                    <span className="font-picker-name">{font.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 ? <div className="font-picker-group">No fonts match.</div> : null}
          </div>
        </div>
        <div className="font-picker-preview">
          <div className="font-picker-preview-head">
            <strong>{preview.label}</strong>
            <span className="font-picker-preview-note">
              {preview.id === SYSTEM_MONO_FONT.id ? 'Your device default' : 'Bundled with mureview'}
            </span>
          </div>
          <div
            className="font-picker-diff"
            style={
              {
                fontFamily: previewFamily,
                '--diffs-font-family': previewFamily,
                '--diffs-font-size': '15px',
                '--diffs-line-height': '22px',
              } as CSSProperties
            }
          >
            {items.length > 0 ? <CodeView items={items} options={previewOptions} style={{ height: '100%' }} /> : null}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
