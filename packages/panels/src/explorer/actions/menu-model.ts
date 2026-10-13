// 右键菜单的组成：按目标（单个目录 / 单个文件 / 多选 / 空白处）决定有哪些项、怎么分组。
// 纯数据，渲染交给 explorer-context-menu.tsx。

import type { FileEntryDto } from '@vibeterm/shared';
import { isDirectoryEntry } from '../model/entries';
import { EXPLORER_SHORTCUTS, type ExplorerCommand, formatChord } from '../model/shortcuts';

export type ExplorerMenuCommand = ExplorerCommand | 'copyPath' | 'upload' | 'uploadFolder';

export type ExplorerMenuTarget =
  | { kind: 'items'; entries: readonly FileEntryDto[] }
  | { kind: 'background' };

export interface ExplorerMenuItem {
  command: ExplorerMenuCommand;
  labelKey: string;
  shortcut: string | null;
  destructive?: boolean;
  disabled?: boolean;
}

export type ExplorerMenuSection = ExplorerMenuItem[];

export interface ExplorerMenuOptions {
  canPaste: boolean;
  apple: boolean;
}

// 表里虽有快捷键、但菜单上不展示的命令（刷新不绑键，其余三个本就不在表里）
const NO_SHORTCUT: ReadonlySet<ExplorerMenuCommand> = new Set([
  'copyPath',
  'upload',
  'uploadFolder',
  'refresh',
]);

export function menuShortcut(command: ExplorerMenuCommand, apple: boolean): string | null {
  if (NO_SHORTCUT.has(command)) return null;
  const chord = EXPLORER_SHORTCUTS.find((item) => item.command === command)?.chords[0];
  return chord ? formatChord(chord, apple) : null;
}

function item(
  command: ExplorerMenuCommand,
  opts: ExplorerMenuOptions,
  patch: Pick<ExplorerMenuItem, 'destructive' | 'disabled'> = {}
): ExplorerMenuItem {
  return {
    command,
    labelKey: `explorer.menu.${command}`,
    shortcut: menuShortcut(command, opts.apple),
    ...patch,
  };
}

function pasteItem(opts: ExplorerMenuOptions): ExplorerMenuItem {
  return item('paste', opts, opts.canPaste ? {} : { disabled: true });
}

function backgroundMenu(opts: ExplorerMenuOptions): ExplorerMenuSection[] {
  return [
    [item('newFolder', opts), item('upload', opts), item('uploadFolder', opts)],
    [pasteItem(opts)],
    [item('selectAll', opts), item('refresh', opts)],
  ];
}

function itemsMenu(
  entries: readonly FileEntryDto[],
  opts: ExplorerMenuOptions
): ExplorerMenuSection[] {
  const single = entries.length === 1 ? entries[0] : undefined;
  const singleDir = single !== undefined && isDirectoryEntry(single);
  const sections: ExplorerMenuSection[] = [];
  if (single) {
    const open = [item('open', opts)];
    if (singleDir) open.push(item('openInNewTab', opts));
    sections.push(open);
  }
  sections.push([item('download', opts)]);
  // 粘贴只对「粘到这个目录里」有意义：单个目录才给
  const clipboard = [item('cut', opts), item('copy', opts)];
  if (singleDir) clipboard.push(pasteItem(opts));
  sections.push(clipboard);
  if (single) sections.push([item('rename', opts), item('copyPath', opts)]);
  sections.push([item('delete', opts, { destructive: true })]);
  return sections;
}

export function buildExplorerMenu(
  target: ExplorerMenuTarget,
  opts: ExplorerMenuOptions
): ExplorerMenuSection[] {
  if (target.kind === 'background' || target.entries.length === 0) return backgroundMenu(opts);
  return itemsMenu(target.entries, opts);
}
