// 两种视图的静态渲染冒烟测试 + 容器委托用到的纯函数。
// bun test 无 DOM，用 react-dom/server 渲染后断言 HTML（做法同 files/ops/file-name-dialog.test.tsx）。
// i18n 不装资源：t() 原样回显 key。

import { describe, expect, test } from 'bun:test';
import type { FileEntryDto } from '@vibeterm/shared';
import i18next from 'i18next';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { EMPTY_SELECTION, type SelectionState, selectOnly } from '../model/selection';
import { ExplorerGridView } from './explorer-grid-view';
import { ExplorerListView } from './explorer-list-view';
import { nextSort } from './list-header';
import {
  dropPathOf,
  isCheckTarget,
  isDraggableTarget,
  isInertTarget,
  rowPathOf,
} from './row-target';
import { clickSelection } from './use-view-interactions';
import { createDateFormatter, itemPropsEqual } from './view-parts';
import type { ExplorerViewProps } from './view-types';

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh_CN',
  fallbackLng: 'zh_CN',
  resources: {},
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

function file(name: string, init: Partial<FileEntryDto> = {}): FileEntryDto {
  return {
    name,
    path: `/srv/root/${name}`,
    type: 'file',
    category: 'text',
    size: 2048,
    modifiedAt: '2026-01-02T03:04:05.000Z',
    isSymlink: false,
    ...init,
  };
}

function dir(name: string): FileEntryDto {
  return file(name, { type: 'dir', category: 'directory', size: null });
}

const ENTRIES: FileEntryDto[] = [
  dir('docs'),
  file('a.txt'),
  file('b.md', { category: 'markdown' }),
  file('link', { type: 'symlink', isSymlink: true }),
];

const noop = (): void => undefined;

function viewProps(init: Partial<ExplorerViewProps> = {}): ExplorerViewProps {
  return {
    entries: ENTRIES,
    selection: EMPTY_SELECTION,
    cutPaths: new Set<string>(),
    renamingPath: null,
    pendingFolder: null,
    sort: { key: 'name', dir: 'asc' },
    dropTargetPath: null,
    coarsePointer: false,
    onSortChange: noop,
    onSelectionChange: noop,
    onOpen: noop,
    onContextMenu: noop,
    onRenameCommit: noop,
    onRenameCancel: noop,
    onPendingFolderCommit: noop,
    onPendingFolderCancel: noop,
    onItemDragStart: noop,
    onItemDragEnd: noop,
    onDragOverTarget: noop,
    onDropTarget: noop,
    onDragLeaveAll: noop,
    ...init,
  };
}

function render(element: ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function rowTag(html: string, name: string): string {
  const match = html.match(new RegExp(`<div[^>]*data-testid="explorer-item-${name}"[^>]*>`));
  if (!match) throw new Error(`row ${name} not rendered`);
  return match[0];
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const VIEWS = [
  ['list', ExplorerListView],
  ['grid', ExplorerGridView],
] as const;

describe.each(VIEWS)('%s view', (_name, View) => {
  test('container is a multi-selectable listbox and the single tab stop', () => {
    const html = render(<View {...viewProps()} />);
    const container = html.match(/<div[^>]*data-testid="explorer-view"[^>]*>/)?.[0] ?? '';
    expect(container).toContain('role="listbox"');
    expect(container).toContain('aria-multiselectable="true"');
    expect(container).toContain('tabindex="0"');
    expect(count(html, 'tabindex="0"')).toBe(1);
  });

  test('renders one option per entry with its path', () => {
    const html = render(<View {...viewProps()} />);
    expect(count(html, 'role="option"')).toBe(ENTRIES.length);
    for (const entry of ENTRIES) {
      const tag = rowTag(html, entry.name);
      expect(tag).toContain(`data-explorer-path="${entry.path}"`);
      expect(tag).toContain('aria-selected="false"');
    }
    expect(rowTag(html, 'docs')).toContain('data-explorer-dir');
    expect(rowTag(html, 'a.txt')).not.toContain('data-explorer-dir');
    expect(html).toContain('title="files.symlink"');
  });

  test('selection, focus, cut and drop-target states', () => {
    const selection: SelectionState = {
      selected: new Set(['/srv/root/a.txt', '/srv/root/b.md']),
      anchor: '/srv/root/a.txt',
      focus: '/srv/root/b.md',
    };
    const html = render(
      <View
        {...viewProps({
          selection,
          cutPaths: new Set(['/srv/root/link']),
          dropTargetPath: '/srv/root/docs',
        })}
      />
    );
    expect(rowTag(html, 'a.txt')).toContain('aria-selected="true"');
    expect(rowTag(html, 'a.txt')).toContain('bg-primary/12');
    expect(rowTag(html, 'b.md')).toContain('aria-selected="true"');
    expect(rowTag(html, 'b.md')).toContain('data-focused=""');
    expect(rowTag(html, 'a.txt')).not.toContain('data-focused=');
    expect(rowTag(html, 'docs')).toContain('aria-selected="false"');
    expect(rowTag(html, 'docs')).toContain('ring-primary/50');
    expect(rowTag(html, 'link')).toContain('opacity-50');
    // 键盘光标所在行通过 aria-activedescendant 暴露
    const id = rowTag(html, 'b.md').match(/ id="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`aria-activedescendant="${id}"`);
  });

  test('pending folder renders first with an editor', () => {
    const html = render(<View {...viewProps({ pendingFolder: { name: '未命名文件夹' } })} />);
    const pending = html.indexOf('data-testid="explorer-pending-folder"');
    const first = html.indexOf('data-testid="explorer-item-docs"');
    expect(pending).toBeGreaterThan(-1);
    expect(pending).toBeLessThan(first);
    const editor = html.match(/<input[^>]*data-testid="explorer-name-editor"[^>]*>/)?.[0] ?? '';
    expect(editor).toContain('value="未命名文件夹"');
    expect(count(html, 'role="option"')).toBe(ENTRIES.length);
  });

  test('renaming row swaps the name for an input and is not draggable', () => {
    const html = render(<View {...viewProps({ renamingPath: '/srv/root/a.txt' })} />);
    expect(count(html, 'data-testid="explorer-name-editor"')).toBe(1);
    const editor = html.match(/<input[^>]*data-testid="explorer-name-editor"[^>]*>/)?.[0] ?? '';
    expect(editor).toContain('value="a.txt"');
    expect(editor).toContain('aria-label="files.ops.nameLabel"');
    // 其余三行仍是拖拽源
    expect(count(html, 'draggable="true"')).toBe(ENTRIES.length - 1);
  });

  test('fine pointer: every item is a drag source and there are no checkboxes', () => {
    const html = render(<View {...viewProps()} />);
    expect(count(html, 'draggable="true"')).toBe(ENTRIES.length);
    expect(html).not.toContain('data-explorer-check');
  });

  test('coarse pointer: leading checkboxes, nothing draggable', () => {
    const html = render(
      <View {...viewProps({ coarsePointer: true, selection: selectOnly('/srv/root/a.txt') })} />
    );
    expect(count(html, 'data-explorer-check')).toBe(ENTRIES.length);
    expect(html).toContain('data-testid="explorer-check-a.txt"');
    expect(html).not.toContain('draggable="true"');
  });

  test('entrance stagger only covers the first 24 items', () => {
    const many = Array.from({ length: 40 }, (_, index) => file(`f${index}.txt`));
    const html = render(<View {...viewProps({ entries: many })} />);
    expect(count(html, 'vibeterm-explorer-row-in')).toBe(24);
    expect(rowTag(html, 'f23.txt')).toContain('--vibeterm-stagger-index:23');
    expect(rowTag(html, 'f24.txt')).not.toContain('vibeterm-explorer-row-in');
  });

  test('content-visibility kicks in above 200 entries only', () => {
    const small = Array.from({ length: 200 }, (_, index) => file(`f${index}.txt`));
    expect(render(<View {...viewProps({ entries: small })} />)).not.toContain('content-visibility');
    const large = Array.from({ length: 201 }, (_, index) => file(`f${index}.txt`));
    const html = render(<View {...viewProps({ entries: large })} />);
    expect(count(html, 'content-visibility:auto')).toBe(201);
  });
});

describe('list view details', () => {
  test('header marks the active sort column', () => {
    const html = render(
      <ExplorerListView {...viewProps({ sort: { key: 'size', dir: 'desc' } })} />
    );
    expect(count(html, 'role="columnheader"')).toBe(4);
    expect(count(html, 'aria-sort="descending"')).toBe(1);
    expect(count(html, 'aria-sort="none"')).toBe(3);
    expect(html).toContain('explorer.column.name');
    expect(html).toContain('explorer.column.modified');
  });

  test('size, kind and modified columns', () => {
    const html = render(<ExplorerListView {...viewProps()} />);
    expect(html).toContain('explorer.kind.directory');
    expect(html).toContain('explorer.kind.markdown');
    expect(html).toContain('explorer.kind.symlink');
    expect(html).toContain('2026');
    // 目录不显示大小
    const docs = html.slice(html.indexOf('data-testid="explorer-item-docs"'));
    expect(docs.slice(0, docs.indexOf('explorer.kind.directory'))).toContain('—');
  });

  test('large lists use the 30px intrinsic row size, grids the 96px tile size', () => {
    const large = Array.from({ length: 201 }, (_, index) => file(`f${index}.txt`));
    expect(render(<ExplorerListView {...viewProps({ entries: large })} />)).toContain(
      'contain-intrinsic-size:auto 30px'
    );
    expect(render(<ExplorerGridView {...viewProps({ entries: large })} />)).toContain(
      'contain-intrinsic-size:auto 96px'
    );
  });
});

describe('list view drag sources', () => {
  test('a selected row is draggable as a whole, an unselected one only by its name cell', () => {
    const html = render(
      <ExplorerListView {...viewProps({ selection: selectOnly('/srv/root/a.txt') })} />
    );
    expect(rowTag(html, 'a.txt')).toContain('draggable="true"');
    expect(rowTag(html, 'b.md')).toContain('draggable="false"');
    // 4 个名称单元格 + 1 个已选中的整行
    expect(count(html, 'draggable="true"')).toBe(ENTRIES.length + 1);
  });

  test('a selected row being renamed or on a coarse pointer is not draggable', () => {
    const selection = selectOnly('/srv/root/a.txt');
    const renaming = render(
      <ExplorerListView {...viewProps({ selection, renamingPath: '/srv/root/a.txt' })} />
    );
    expect(rowTag(renaming, 'a.txt')).toContain('draggable="false"');
    const coarse = render(<ExplorerListView {...viewProps({ selection, coarsePointer: true })} />);
    expect(coarse).not.toContain('draggable="true"');
  });
});

describe('nextSort', () => {
  test('clicking the active column flips direction', () => {
    expect(nextSort({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort({ key: 'name', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  test('another column starts with its natural direction', () => {
    expect(nextSort({ key: 'name', dir: 'desc' }, 'kind')).toEqual({ key: 'kind', dir: 'asc' });
    expect(nextSort({ key: 'name', dir: 'asc' }, 'size')).toEqual({ key: 'size', dir: 'desc' });
    expect(nextSort({ key: 'size', dir: 'desc' }, 'modifiedAt')).toEqual({
      key: 'modifiedAt',
      dir: 'desc',
    });
    expect(nextSort({ key: 'size', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('clickSelection', () => {
  const order = ['/a', '/b', '/c', '/d'];
  const base: SelectionState = { selected: new Set(['/b']), anchor: '/b', focus: '/b' };

  test('plain click selects only that item', () => {
    const next = clickSelection(base, order, '/d', { mod: false, shift: false });
    expect([...next.selected]).toEqual(['/d']);
    expect(next.focus).toBe('/d');
  });

  test('mod click toggles', () => {
    const added = clickSelection(base, order, '/d', { mod: true, shift: false });
    expect([...added.selected].sort()).toEqual(['/b', '/d']);
    const removed = clickSelection(added, order, '/b', { mod: true, shift: false });
    expect([...removed.selected]).toEqual(['/d']);
  });

  test('shift click selects the range from the anchor; with mod it adds to the selection', () => {
    const range = clickSelection(base, order, '/d', { mod: false, shift: true });
    expect([...range.selected]).toEqual(['/b', '/c', '/d']);
    expect(range.anchor).toBe('/b');
    const scattered: SelectionState = {
      selected: new Set(['/a', '/c']),
      anchor: '/c',
      focus: '/c',
    };
    const additive = clickSelection(scattered, order, '/d', { mod: true, shift: true });
    expect([...additive.selected].sort()).toEqual(['/a', '/c', '/d']);
  });
});

describe('row-target delegation', () => {
  interface FakeElement {
    attrs: Record<string, string>;
    parent: FakeElement | null;
    closest(selector: string): FakeElement | null;
    getAttribute(name: string): string | null;
  }

  // 只支持本模块用到的两种选择器：[attr] 与 [attr="value"]
  function fake(attrs: Record<string, string>, parent: FakeElement | null = null): FakeElement {
    const element: FakeElement = {
      attrs,
      parent,
      closest(selector) {
        const [, name, value] = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/) ?? [];
        for (let node: FakeElement | null = element; node; node = node.parent) {
          const actual = node.attrs[name];
          if (actual !== undefined && (value === undefined || actual === value)) return node;
        }
        return null;
      },
      getAttribute(name) {
        return element.attrs[name] ?? null;
      },
    };
    return element;
  }

  const container = fake({ role: 'listbox' });
  const dirRow = fake({ 'data-explorer-path': '/srv/docs', 'data-explorer-dir': '' }, container);
  const fileRow = fake({ 'data-explorer-path': '/srv/a.txt' }, container);
  const nameCell = fake({ draggable: 'true' }, fileRow);
  const label = fake({}, nameCell);
  const check = fake({ 'data-explorer-check': '' }, fileRow);
  const header = fake({ 'data-explorer-inert': '' }, container);

  test('resolves the row from any descendant, null on the background', () => {
    expect(rowPathOf(label)).toBe('/srv/a.txt');
    expect(rowPathOf(dirRow)).toBe('/srv/docs');
    expect(rowPathOf(container)).toBeNull();
    expect(rowPathOf(null)).toBeNull();
    expect(rowPathOf('text')).toBeNull();
  });

  test('only directory rows are drop targets', () => {
    expect(dropPathOf(dirRow)).toBe('/srv/docs');
    expect(dropPathOf(label)).toBeNull();
    expect(dropPathOf(container)).toBeNull();
  });

  test('inert, checkbox and drag-source detection', () => {
    expect(isInertTarget(fake({}, header))).toBe(true);
    expect(isInertTarget(label)).toBe(false);
    expect(isCheckTarget(fake({}, check))).toBe(true);
    expect(isCheckTarget(label)).toBe(false);
    expect(isDraggableTarget(label)).toBe(true);
    expect(isDraggableTarget(fileRow)).toBe(false);
  });
});

describe('view-parts helpers', () => {
  test('itemPropsEqual compares entries by value', () => {
    const base = { entry: file('a.txt'), selected: false, stagger: null as number | null };
    expect(itemPropsEqual(base, { ...base, entry: file('a.txt') })).toBe(true);
    expect(itemPropsEqual(base, { ...base, selected: true })).toBe(false);
    expect(itemPropsEqual(base, { ...base, entry: file('a.txt', { size: 1 }) })).toBe(false);
    expect(itemPropsEqual(base, { ...base, entry: file('a.txt', { modifiedAt: null }) })).toBe(
      false
    );
  });

  test('createDateFormatter tolerates i18next locale tags and missing dates', () => {
    const format = createDateFormatter('zh_CN');
    expect(format(null)).toBe('—');
    expect(format('not a date')).toBe('—');
    expect(format('2026-01-02T03:04:05.000Z')).toContain('2026');
    expect(createDateFormatter('!!bad!!')(null)).toBe('—');
    expect(createDateFormatter(undefined)('2026-01-02T03:04:05.000Z')).toContain('2026');
  });
});
