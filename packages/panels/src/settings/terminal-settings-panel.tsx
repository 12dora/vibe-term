import type { KeyboardBehaviorMode } from '@tmex/stores';
import { useUIStore } from '@tmex/stores/react';
import { FONT_MANIFEST, getFontEntry } from '@tmex/theme';
import { cn } from '@tmex/ui';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Skeleton } from '@tmex/ui/skeleton';
import { Check } from 'lucide-react';
import {
  type KeyboardEvent,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { TerminalShortcutsEditor } from './TerminalShortcutsEditor';
import {
  type DeferredCommit,
  createDeferredCommit,
  parseNumericSetting,
} from './numeric-setting-draft';

// 预览要拉起 Ghostty 的 WASM 与终端字体，是这个面板最重的一块，却和上手就要改的
// 字号/行高/字体/快捷键毫无依赖关系：切成独立 chunk，控件先出来，预览随后补上。
const TerminalPreview = lazy(() =>
  import('@tmex/terminal-ui').then((m) => ({ default: m.TerminalPreview }))
);

const FONT_SIZE_MIN = 8;
const FONT_SIZE_MAX = 28;
const LINE_HEIGHT_MIN = 1;
const LINE_HEIGHT_MAX = 2;

// 手机键盘弹出时的页面避让模式（issue #27），并入终端设置。
const KEYBOARD_MODE_ITEMS = [
  {
    value: 'lift',
    labelKey: 'terminal.keyboardBehavior.modeLift',
    descKey: 'terminal.keyboardBehavior.modeLiftDesc',
  },
  {
    value: 'resize',
    labelKey: 'terminal.keyboardBehavior.modeResize',
    descKey: 'terminal.keyboardBehavior.modeResizeDesc',
  },
  {
    value: 'follow',
    labelKey: 'terminal.keyboardBehavior.modeFollow',
    descKey: 'terminal.keyboardBehavior.modeFollowDesc',
  },
] as const satisfies ReadonlyArray<{
  value: KeyboardBehaviorMode;
  labelKey: string;
  descKey: string;
}>;

function TerminalPreviewSection() {
  const { t } = useTranslation();
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  // 占位高度与 TerminalPreview 自己的算法一致（约 12 行），预览挂上来时版式不跳。
  const heightPx = Math.ceil(fontSize * lineHeight * 12);

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium">{t('settings.terminal.preview')}</span>
      <Suspense
        fallback={
          <Skeleton
            className="w-full border"
            style={{ height: `${heightPx}px` }}
            data-testid="terminal-preview-placeholder"
          />
        }
      >
        <TerminalPreview />
      </Suspense>
    </div>
  );
}

/**
 * 数字设置项：输入只改本地草稿，提交走失焦 / 回车 / 停手 250 ms 后的延时窗口
 * （见 `numeric-setting-draft.ts`）。store 值被别处改掉时才回灌草稿——自己刚提交的那次不回灌，
 * 否则延时提交会把用户还在敲的内容改写掉。
 */
function useNumericSetting(
  value: number,
  commit: (next: number) => void,
  min: number,
  max: number
) {
  const [draft, setDraft] = useState(() => String(value));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const committedRef = useRef(value);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const pendingRef = useRef<DeferredCommit<number> | null>(null);
  if (!pendingRef.current) {
    pendingRef.current = createDeferredCommit<number>((next) => {
      committedRef.current = next;
      commitRef.current(next);
    });
  }
  const pending = pendingRef.current;

  useEffect(() => {
    if (value === committedRef.current) return;
    committedRef.current = value;
    setDraft(String(value));
  }, [value]);

  useEffect(() => () => pending.cancel(), [pending]);

  const flush = useCallback(() => {
    pending.cancel();
    const next = parseNumericSetting(draftRef.current, min, max);
    if (next === null) {
      setDraft(String(committedRef.current));
      return;
    }
    if (next === committedRef.current) return;
    committedRef.current = next;
    commitRef.current(next);
  }, [pending, min, max]);

  const onChange = useCallback(
    (raw: string) => {
      setDraft(raw);
      const next = parseNumericSetting(raw, min, max);
      if (next === null || next === committedRef.current) {
        pending.cancel();
        return;
      }
      pending.schedule(next);
    },
    [pending, min, max]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') flush();
    },
    [flush]
  );

  return { value: draft, onChange, onBlur: flush, onKeyDown };
}

/**
 * 终端设置面板（设置页 Tab 与终端页右上角 Sheet 复用同一组件）。
 * 字体/键盘行为即改即生效；字号/行高在失焦、回车或停手后生效（见 `useNumericSetting`）。
 * 全部仅保存在当前浏览器。
 */
export function TerminalSettingsPanel({
  showPreview = true,
  showShortcuts = true,
}: {
  showPreview?: boolean;
  /** 是否在面板内联快捷键编辑器（Sheet=true 单弹层；设置页 Tab=false 由独立卡片承载） */
  showShortcuts?: boolean;
}) {
  const { t } = useTranslation();

  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useUIStore((state) => state.setTerminalFontSize);
  const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);
  const setTerminalLineHeight = useUIStore((state) => state.setTerminalLineHeight);
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const setTerminalFontId = useUIStore((state) => state.setTerminalFontId);
  const keyboardMode = useUIStore((state) => state.keyboardBehaviorMode);
  const setKeyboardMode = useUIStore((state) => state.setKeyboardBehaviorMode);

  const fontSizeField = useNumericSetting(
    terminalFontSize,
    setTerminalFontSize,
    FONT_SIZE_MIN,
    FONT_SIZE_MAX
  );
  const lineHeightField = useNumericSetting(
    terminalLineHeight,
    setTerminalLineHeight,
    LINE_HEIGHT_MIN,
    LINE_HEIGHT_MAX
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">{t('settings.terminal.description')}</p>

      {showPreview && <TerminalPreviewSection />}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="terminal-font-size">
            {t('settings.terminal.fontSize')}
          </label>
          <Input
            id="terminal-font-size"
            data-testid="terminal-font-size"
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            step={1}
            value={fontSizeField.value}
            onChange={(event) => fontSizeField.onChange(event.target.value)}
            onBlur={fontSizeField.onBlur}
            onKeyDown={fontSizeField.onKeyDown}
            className="min-h-10"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor="terminal-line-height">
            {t('settings.terminal.lineHeight')}
          </label>
          <Input
            id="terminal-line-height"
            data-testid="terminal-line-height"
            type="number"
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            step={0.1}
            value={lineHeightField.value}
            onChange={(event) => lineHeightField.onChange(event.target.value)}
            onBlur={lineHeightField.onBlur}
            onKeyDown={lineHeightField.onKeyDown}
            className="min-h-10"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium" htmlFor="terminal-font-family">
          {t('settings.terminal.fontFamily')}
        </label>
        <Select
          value={terminalFontId}
          onValueChange={(value) => {
            if (value) {
              setTerminalFontId(value);
            }
          }}
        >
          <SelectTrigger
            id="terminal-font-family"
            data-testid="terminal-font-family"
            className="min-h-10 w-full"
          >
            <SelectValue>{getFontEntry(terminalFontId).displayName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FONT_MANIFEST.map((font) => (
              <SelectItem key={font.id} value={font.id}>
                {font.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium">{t('terminal.keyboardBehavior.title')}</span>
        <p className="text-muted-foreground text-xs">
          {t('terminal.keyboardBehavior.description')}
        </p>
        <div className="flex flex-col gap-2">
          {KEYBOARD_MODE_ITEMS.map((item) => {
            const selected = keyboardMode === item.value;
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setKeyboardMode(item.value)}
                aria-pressed={selected}
                data-testid={`keyboard-behavior-option-${item.value}`}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {selected && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(item.labelKey)}</span>
                  <span className="text-muted-foreground text-xs leading-snug">
                    {t(item.descKey)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">{t('settings.terminal.savedInBrowser')}</p>

      {showShortcuts && (
        <>
          <div className="h-px bg-border" />

          <div className="space-y-2">
            <span className="block font-medium text-sm">
              {t('settings.terminal.shortcuts.title')}
            </span>
            <p className="text-muted-foreground text-xs">
              {t('settings.terminal.shortcuts.savedOnServer')}
            </p>
            <TerminalShortcutsEditor />
          </div>
        </>
      )}
    </div>
  );
}
