import { describe, expect, test } from 'bun:test';
import type { FileEntryDto } from '@vibeterm/shared';
import {
  type ExplorerMenuCommand,
  type ExplorerMenuSection,
  buildExplorerMenu,
  menuShortcut,
} from './menu-model';

function entry(name: string, type: FileEntryDto['type'] = 'file'): FileEntryDto {
  return {
    name,
    path: `/root/${name}`,
    type,
    category: type === 'dir' ? 'directory' : 'text',
    size: type === 'dir' ? null : 1,
    modifiedAt: null,
    isSymlink: false,
  } as FileEntryDto;
}

const commands = (sections: ExplorerMenuSection[]): ExplorerMenuCommand[][] =>
  sections.map((section) => section.map((item) => item.command));

function find(sections: ExplorerMenuSection[], command: ExplorerMenuCommand) {
  return sections.flat().find((item) => item.command === command);
}

const WIN = { canPaste: true, apple: false };
const MAC = { canPaste: true, apple: true };

describe('buildExplorerMenu — items', () => {
  test('single directory: open + new tab, paste into it, rename/copy path, delete last', () => {
    const menu = buildExplorerMenu({ kind: 'items', entries: [entry('src', 'dir')] }, WIN);
    expect(commands(menu)).toEqual([
      ['open', 'openInNewTab'],
      ['download'],
      ['cut', 'copy', 'paste'],
      ['rename', 'copyPath'],
      ['delete'],
    ]);
  });

  test('single file: no new tab and no paste', () => {
    const menu = buildExplorerMenu({ kind: 'items', entries: [entry('a.txt')] }, WIN);
    expect(commands(menu)).toEqual([
      ['open'],
      ['download'],
      ['cut', 'copy'],
      ['rename', 'copyPath'],
      ['delete'],
    ]);
  });

  test('a symlink is treated as a non-directory', () => {
    const menu = buildExplorerMenu({ kind: 'items', entries: [entry('link', 'symlink')] }, WIN);
    expect(commands(menu)[0]).toEqual(['open']);
    expect(find(menu, 'paste')).toBeUndefined();
  });

  test('multi selection: only download / cut / copy / delete', () => {
    const menu = buildExplorerMenu(
      { kind: 'items', entries: [entry('src', 'dir'), entry('a.txt')] },
      WIN
    );
    expect(commands(menu)).toEqual([['download'], ['cut', 'copy'], ['delete']]);
  });

  test('delete is the only destructive item and always sits in the last section', () => {
    const targets = [[entry('src', 'dir')], [entry('a.txt')], [entry('a.txt'), entry('b.txt')]];
    for (const entries of targets) {
      const menu = buildExplorerMenu({ kind: 'items', entries }, WIN);
      const destructive = menu.flat().filter((item) => item.destructive);
      expect(destructive.map((item) => item.command)).toEqual(['delete']);
      expect(commands(menu).at(-1)).toEqual(['delete']);
    }
  });

  test('paste on a directory is disabled without a clipboard', () => {
    const target = { kind: 'items' as const, entries: [entry('src', 'dir')] };
    expect(find(buildExplorerMenu(target, WIN), 'paste')?.disabled).toBeUndefined();
    expect(find(buildExplorerMenu(target, { ...WIN, canPaste: false }), 'paste')?.disabled).toBe(
      true
    );
  });

  test('an empty items target falls back to the background menu', () => {
    expect(buildExplorerMenu({ kind: 'items', entries: [] }, WIN)).toEqual(
      buildExplorerMenu({ kind: 'background' }, WIN)
    );
  });
});

describe('buildExplorerMenu — background', () => {
  test('sections and order', () => {
    const menu = buildExplorerMenu({ kind: 'background' }, WIN);
    expect(commands(menu)).toEqual([
      ['newFolder', 'upload', 'uploadFolder'],
      ['paste'],
      ['selectAll', 'refresh'],
    ]);
    expect(menu.flat().some((item) => item.destructive)).toBe(false);
  });

  test('paste follows canPaste', () => {
    const on = buildExplorerMenu({ kind: 'background' }, WIN);
    const off = buildExplorerMenu({ kind: 'background' }, { ...WIN, canPaste: false });
    expect(find(on, 'paste')?.disabled).toBeUndefined();
    expect(find(off, 'paste')?.disabled).toBe(true);
  });
});

describe('labels and shortcuts', () => {
  test('every item uses its explorer.menu.* key', () => {
    const menus = [
      buildExplorerMenu({ kind: 'background' }, WIN),
      buildExplorerMenu({ kind: 'items', entries: [entry('src', 'dir')] }, WIN),
    ];
    for (const item of menus.flat(2)) {
      expect(item.labelKey).toBe(`explorer.menu.${item.command}`);
    }
  });

  test('non-apple labels', () => {
    const menu = buildExplorerMenu({ kind: 'items', entries: [entry('src', 'dir')] }, WIN);
    expect(find(menu, 'open')?.shortcut).toBe('Enter');
    expect(find(menu, 'openInNewTab')?.shortcut).toBe('Ctrl+Enter');
    expect(find(menu, 'download')?.shortcut).toBe('Ctrl+S');
    expect(find(menu, 'cut')?.shortcut).toBe('Ctrl+X');
    expect(find(menu, 'copy')?.shortcut).toBe('Ctrl+C');
    expect(find(menu, 'paste')?.shortcut).toBe('Ctrl+V');
    expect(find(menu, 'rename')?.shortcut).toBe('F2');
    expect(find(menu, 'delete')?.shortcut).toBe('Delete');
  });

  test('apple labels', () => {
    const menu = buildExplorerMenu({ kind: 'items', entries: [entry('src', 'dir')] }, MAC);
    expect(find(menu, 'open')?.shortcut).toBe('↩');
    expect(find(menu, 'openInNewTab')?.shortcut).toBe('⌘↩');
    expect(find(menu, 'download')?.shortcut).toBe('⌘S');
    expect(find(menu, 'copy')?.shortcut).toBe('⌘C');
    expect(find(menu, 'rename')?.shortcut).toBe('F2');
    expect(find(menu, 'delete')?.shortcut).toBe('⌦');
  });

  test('background shortcuts: alt chord for new folder, mod+A for select all', () => {
    const win = buildExplorerMenu({ kind: 'background' }, WIN);
    const mac = buildExplorerMenu({ kind: 'background' }, MAC);
    expect(find(win, 'newFolder')?.shortcut).toBe('Alt+N');
    expect(find(mac, 'newFolder')?.shortcut).toBe('⌥N');
    expect(find(win, 'selectAll')?.shortcut).toBe('Ctrl+A');
    expect(find(mac, 'selectAll')?.shortcut).toBe('⌘A');
  });

  test('copyPath / upload / uploadFolder / refresh never show a shortcut', () => {
    const silent: ExplorerMenuCommand[] = ['copyPath', 'upload', 'uploadFolder', 'refresh'];
    for (const command of silent) {
      expect(menuShortcut(command, false)).toBeNull();
      expect(menuShortcut(command, true)).toBeNull();
    }
  });
});
