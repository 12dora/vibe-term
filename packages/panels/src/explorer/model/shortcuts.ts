// 文件管理器键盘快捷键：以数据表描述，匹配与展示都从同一张表派生。
// 不绑定浏览器保留的组合（Ctrl+T/W/N/Tab、F5、Ctrl+R）。

export type ExplorerCommand =
  | 'open'
  | 'openInNewTab'
  | 'up'
  | 'back'
  | 'forward'
  | 'refresh'
  | 'selectAll'
  | 'clearSelection'
  | 'rename'
  | 'delete'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'newFolder'
  | 'focusFilter'
  | 'newTab'
  | 'closeTab'
  | 'split'
  | 'showShortcuts'
  | 'download';

/** `mod` 在 Apple 平台是 ⌘，其它平台是 Ctrl；带 alt 的组合按 KeyboardEvent.code 匹配。 */
export interface KeyChord {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ExplorerShortcut {
  command: ExplorerCommand;
  chords: KeyChord[];
  labelKey: string;
}

export type ExplorerKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

function shortcut(command: ExplorerCommand, chords: KeyChord[]): ExplorerShortcut {
  return { command, chords, labelKey: `explorer.shortcuts.${command}` };
}

export const EXPLORER_SHORTCUTS: ReadonlyArray<ExplorerShortcut> = [
  shortcut('open', [{ key: 'Enter' }, { key: 'ArrowDown', mod: true }, { key: 'o', mod: true }]),
  shortcut('openInNewTab', [{ key: 'Enter', mod: true }]),
  shortcut('up', [
    { key: 'Backspace' },
    { key: 'ArrowUp', alt: true },
    { key: 'ArrowUp', mod: true },
  ]),
  shortcut('back', [
    { key: 'ArrowLeft', alt: true },
    { key: '[', mod: true },
  ]),
  shortcut('forward', [
    { key: 'ArrowRight', alt: true },
    { key: ']', mod: true },
  ]),
  shortcut('selectAll', [{ key: 'a', mod: true }]),
  shortcut('clearSelection', [{ key: 'Escape' }]),
  shortcut('rename', [{ key: 'F2' }]),
  shortcut('delete', [{ key: 'Delete' }, { key: 'Backspace', mod: true }]),
  shortcut('copy', [{ key: 'c', mod: true }]),
  shortcut('cut', [{ key: 'x', mod: true }]),
  shortcut('paste', [{ key: 'v', mod: true }]),
  shortcut('newFolder', [{ key: 'n', alt: true }]),
  shortcut('focusFilter', [{ key: 'f', mod: true }, { key: '/' }]),
  shortcut('newTab', [{ key: 't', alt: true }]),
  shortcut('closeTab', [{ key: 'w', alt: true }]),
  shortcut('split', [{ key: '\\', alt: true }]),
  shortcut('download', [{ key: 's', mod: true }]),
  shortcut('showShortcuts', [{ key: '?' }]),
];

const PUNCTUATION_CODES: Record<string, string> = {
  '\\': 'Backslash',
  '/': 'Slash',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

// macOS 上按住 Option 会改写 `key`（⌥N → ˜），带 alt 的组合只能比物理键位。
function chordCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  return PUNCTUATION_CODES[key] ?? key;
}

function keyMatches(event: ExplorerKeyEvent, chord: KeyChord): boolean {
  if (chord.alt) return event.code === chordCode(chord.key);
  return event.key.toLowerCase() === chord.key.toLowerCase();
}

function chordMatches(event: ExplorerKeyEvent, chord: KeyChord, apple: boolean): boolean {
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (otherMod || mod !== Boolean(chord.mod) || event.altKey !== Boolean(chord.alt)) return false;
  // `?` 在多数键盘布局上本身就要按 Shift，不校验
  if (chord.key !== '?' && event.shiftKey !== Boolean(chord.shift)) return false;
  return keyMatches(event, chord);
}

export function matchExplorerCommand(
  event: ExplorerKeyEvent,
  apple: boolean
): ExplorerCommand | null {
  for (const { command, chords } of EXPLORER_SHORTCUTS) {
    if (chords.some((chord) => chordMatches(event, chord, apple))) return command;
  }
  return null;
}

const ARROW_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

const APPLE_KEY_LABELS: Record<string, string> = {
  ...ARROW_LABELS,
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: '⎋',
};

const DEFAULT_KEY_LABELS: Record<string, string> = { ...ARROW_LABELS, Escape: 'Esc' };

function keyLabel(key: string, labels: Record<string, string>): string {
  return labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export function formatChord(chord: KeyChord, apple: boolean): string {
  if (apple) {
    const modifiers = `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.mod ? '⌘' : ''}`;
    return modifiers + keyLabel(chord.key, APPLE_KEY_LABELS);
  }
  const parts: string[] = [];
  if (chord.mod) parts.push('Ctrl');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(keyLabel(chord.key, DEFAULT_KEY_LABELS));
  return parts.join('+');
}

export function isApplePlatformName(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isApplePlatformName(nav.userAgentData?.platform ?? nav.platform ?? '');
}

const EDITABLE_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 焦点在可编辑控件里时不触发命令（Escape 由调用方单独放行）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as Partial<Pick<HTMLElement, 'tagName' | 'isContentEditable'>> | null;
  if (!element || typeof element.tagName !== 'string') return false;
  return EDITABLE_TAGS.has(element.tagName.toUpperCase()) || element.isContentEditable === true;
}
