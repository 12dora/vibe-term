import { describe, expect, test } from 'bun:test';

import {
  PANE_SNAPSHOT_FORMAT,
  SNAPSHOT_FIELD_SEPARATOR,
  WINDOW_SNAPSHOT_FORMAT,
  formatSnapshotRowForLog,
  isTmuxPaneId,
  isTmuxSessionId,
  isTmuxWindowId,
  parsePaneSnapshotRow,
  parseSnapshotInteger,
  parseWindowSnapshotRow,
  splitSnapshotFields,
} from './snapshot-format';
import {
  FLEXIBLE_FIELD_LAYOUTS,
  foldFlexibleFields,
  tokenizeSnapshotFields,
} from './snapshot-format-tokenize';

describe('snapshot format helpers', () => {
  test('uses a locale-stable visible ASCII field separator', () => {
    expect(SNAPSHOT_FIELD_SEPARATOR).toBe('|');
  });

  test('keeps separator characters inside flexible middle fields', () => {
    expect(splitSnapshotFields('@1|0|name|with|pipe|1', 4)).toEqual([
      '@1',
      '0',
      'name|with|pipe',
      '1',
    ]);

    expect(splitSnapshotFields('%1|@1|0|title|with|pipe|1|80|24|1|node', 9)).toEqual([
      '%1',
      '@1',
      '0',
      'title|with|pipe',
      '1',
      '80',
      '24',
      '1',
      'node',
    ]);
  });

  test('validates tmux id shapes', () => {
    expect(isTmuxSessionId('$1')).toBe(true);
    expect(isTmuxSessionId('$abc')).toBe(false);

    expect(isTmuxWindowId('@1')).toBe(true);
    expect(isTmuxWindowId('@0_0_bash_1')).toBe(false);

    expect(isTmuxPaneId('%1')).toBe(true);
    expect(isTmuxPaneId('%1_bad')).toBe(false);
  });

  test('parses snapshot integers strictly', () => {
    expect(parseSnapshotInteger('0')).toBe(0);
    expect(parseSnapshotInteger('80')).toBe(80);
    expect(parseSnapshotInteger('0abc')).toBeNull();
    expect(parseSnapshotInteger('80x')).toBeNull();
    expect(parseSnapshotInteger('')).toBeNull();
    expect(parseSnapshotInteger(undefined)).toBeNull();
  });

  test('truncates snapshot rows before logging', () => {
    const row = `@1|0|${'x'.repeat(200)}|1`;
    const formatted = formatSnapshotRowForLog(row);

    expect(formatted.length).toBeLessThan(row.length);
    expect(formatted.endsWith('...')).toBe(true);
  });
});

describe('parseWindowSnapshotRow', () => {
  test('parses a normal row with layout', () => {
    const row = parseWindowSnapshotRow('@3|2|1|7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}|zsh');
    expect(row).toEqual({
      id: '@3',
      index: 2,
      active: true,
      layout: '7d1d,208x62,0,0{104x62,0,0,0,103x62,105,0,1}',
      name: 'zsh',
    });
  });

  test('window name containing separators is preserved', () => {
    const row = parseWindowSnapshotRow('@1|0|0|ba9d,208x62,0,0,0|name|with|pipe');
    expect(row?.name).toBe('name|with|pipe');
    expect(row?.layout).toBe('ba9d,208x62,0,0,0');
  });

  test('invalid layout degrades to undefined instead of dropping the row', () => {
    const row = parseWindowSnapshotRow('@1|0|1|not-a-layout|zsh');
    expect(row).not.toBeNull();
    expect(row?.layout).toBeUndefined();
  });

  test('rejects rows with invalid id / index / flag', () => {
    expect(parseWindowSnapshotRow('bogus|0|1|ba9d,80x24,0,0,0|zsh')).toBeNull();
    expect(parseWindowSnapshotRow('@1|x|1|ba9d,80x24,0,0,0|zsh')).toBeNull();
    expect(parseWindowSnapshotRow('@1|0|2|ba9d,80x24,0,0,0|zsh')).toBeNull();
    expect(parseWindowSnapshotRow('@1|0|1')).toBeNull();
  });

  test('WINDOW_SNAPSHOT_FORMAT field order matches the parser', () => {
    expect(WINDOW_SNAPSHOT_FORMAT.split('|')).toEqual([
      '#{window_id}',
      '#{window_index}',
      '#{window_active}',
      '#{window_layout}',
      '#{window_name}',
    ]);
  });
});

describe('parsePaneSnapshotRow', () => {
  const base = '%5|@2|1|1|104|62|0|0|1';

  test('parses a normal row', () => {
    const row = parsePaneSnapshotRow(`${base}|my title|node|/home/user/project`);
    expect(row).toEqual({
      id: '%5',
      windowId: '@2',
      index: 1,
      active: true,
      width: 104,
      height: 62,
      left: 0,
      top: 0,
      windowActive: true,
      title: 'my title',
      currentCommand: 'node',
      currentPath: '/home/user/project',
    });
  });

  test('pane title containing separators is joined back', () => {
    const row = parsePaneSnapshotRow(`${base}|title|with|pipe|node|/tmp`);
    expect(row?.title).toBe('title|with|pipe');
    expect(row?.currentCommand).toBe('node');
    expect(row?.currentPath).toBe('/tmp');
  });

  test('empty free-text fields become undefined', () => {
    const row = parsePaneSnapshotRow(`${base}|||`);
    expect(row?.title).toBeUndefined();
    expect(row?.currentCommand).toBeUndefined();
    expect(row?.currentPath).toBeUndefined();
  });

  test('non-zero geometry offsets are parsed', () => {
    const row = parsePaneSnapshotRow('%6|@2|2|0|103|30|105|32|1|t|zsh|/tmp');
    expect(row?.left).toBe(105);
    expect(row?.top).toBe(32);
  });

  test('rejects rows with invalid ids or numbers', () => {
    expect(parsePaneSnapshotRow('bogus|@2|1|1|104|62|0|0|1|t|c|/p')).toBeNull();
    expect(parsePaneSnapshotRow('%5|bogus|1|1|104|62|0|0|1|t|c|/p')).toBeNull();
    expect(parsePaneSnapshotRow('%5|@2|x|1|104|62|0|0|1|t|c|/p')).toBeNull();
    expect(parsePaneSnapshotRow('%5|@2|1|3|104|62|0|0|1|t|c|/p')).toBeNull();
    expect(parsePaneSnapshotRow('%5|@2|1|1|104|62|0|0')).toBeNull();
  });

  test('PANE_SNAPSHOT_FORMAT field order matches the parser', () => {
    expect(PANE_SNAPSHOT_FORMAT.split('|')).toEqual([
      '#{pane_id}',
      '#{window_id}',
      '#{pane_index}',
      '#{pane_active}',
      '#{pane_width}',
      '#{pane_height}',
      '#{pane_left}',
      '#{pane_top}',
      '#{window_active}',
      '#{pane_title}',
      '#{pane_current_command}',
      '#{pane_current_path}',
    ]);
  });

  test('rejects an empty string', () => {
    expect(parsePaneSnapshotRow('')).toBeNull();
  });

  test('rejects a row with too few fields', () => {
    expect(parsePaneSnapshotRow('%5|@2|1|1|104|62|0|0|1|t|c')).toBeNull();
  });

  test('trailing separator makes currentPath empty/undefined', () => {
    const row = parsePaneSnapshotRow(`${base}|title|node|`);
    expect(row).not.toBeNull();
    expect(row?.title).toBe('title');
    expect(row?.currentCommand).toBe('node');
    expect(row?.currentPath).toBeUndefined();
  });

  test('backslash before a separator is split then rejoined into title', () => {
    const row = parsePaneSnapshotRow(`${base}|hello\\|world|node|/tmp`);
    expect(row?.title).toBe('hello\\|world');
    expect(row?.currentCommand).toBe('node');
    expect(row?.currentPath).toBe('/tmp');
  });

  test('extra trailing fields are absorbed into title', () => {
    const row = parsePaneSnapshotRow(`${base}|title|extra|node|/tmp`);
    expect(row?.title).toBe('title|extra');
    expect(row?.currentCommand).toBe('node');
    expect(row?.currentPath).toBe('/tmp');
  });

  test('whitespace-only free-text fields become undefined', () => {
    const row = parsePaneSnapshotRow(`${base}|   |  | `);
    expect(row?.title).toBeUndefined();
    expect(row?.currentCommand).toBeUndefined();
    expect(row?.currentPath).toBeUndefined();
  });

  test('title keeps surrounding whitespace when non-empty after trim', () => {
    const row = parsePaneSnapshotRow(`${base}|  titled  | node | /tmp `);
    expect(row?.title).toBe('  titled  ');
    expect(row?.currentCommand).toBe('node');
    expect(row?.currentPath).toBe('/tmp');
  });

  test('invalid optional geometry becomes undefined without dropping the row', () => {
    const row = parsePaneSnapshotRow('%5|@2|1|1|104|62|x|y|1|t|c|/p');
    expect(row).not.toBeNull();
    expect(row?.left).toBeUndefined();
    expect(row?.top).toBeUndefined();
    expect(row?.width).toBe(104);
  });
});

describe('splitSnapshotFields characterization', () => {
  test('empty string is a single empty field', () => {
    expect(splitSnapshotFields('', 2)).toEqual(['']);
    expect(splitSnapshotFields('', 4)).toEqual(['']);
  });

  test('separator at end is an empty trailing field when count matches', () => {
    expect(splitSnapshotFields('a|', 2)).toEqual(['a', '']);
    expect(splitSnapshotFields('@1|0|name|', 4)).toEqual(['@1', '0', 'name', '']);
  });

  test('separator at end is folded into the flexible field when over count', () => {
    expect(splitSnapshotFields('a|b|', 2)).toEqual(['a', 'b|']);
    expect(splitSnapshotFields('@1|0|name|1|', 4)).toEqual(['@1', '0', 'name|1', '']);
  });

  test('backslash before separator does not prevent a split', () => {
    expect(splitSnapshotFields('a\\|b', 2)).toEqual(['a\\', 'b']);
    expect(splitSnapshotFields('a\\|b|c', 2)).toEqual(['a\\', 'b|c']);
    expect(splitSnapshotFields('@1|0|name\\|with|pipe|1', 4)).toEqual([
      '@1',
      '0',
      'name\\|with|pipe',
      '1',
    ]);
  });

  test('wrong field count below expected returns tokens as-is', () => {
    expect(splitSnapshotFields('a|b', 4)).toEqual(['a', 'b']);
    expect(splitSnapshotFields('@1|0|name', 4)).toEqual(['@1', '0', 'name']);
  });

  test('unknown field count with extra separators returns tokens as-is', () => {
    expect(splitSnapshotFields('a|b|c|d', 3)).toEqual(['a', 'b', 'c', 'd']);
    expect(splitSnapshotFields('a|b', 1)).toEqual(['a', 'b']);
  });

  test('fieldCount 8 joins extras into the fourth field', () => {
    expect(splitSnapshotFields('0|1|2|3|4|5|6|7', 8)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
    ]);
    expect(splitSnapshotFields('0|1|2|mid|dle|4|5|6|7', 8)).toEqual([
      '0',
      '1',
      '2',
      'mid|dle',
      '4',
      '5',
      '6',
      '7',
    ]);
  });

  test('empty middle fields are preserved', () => {
    expect(splitSnapshotFields('@1||name|1', 4)).toEqual(['@1', '', 'name', '1']);
    expect(splitSnapshotFields('id|', 2)).toEqual(['id', '']);
  });

  test('session two-field split joins the rest into name', () => {
    expect(splitSnapshotFields('$1|my|session', 2)).toEqual(['$1', 'my|session']);
  });
});

describe('tokenizeSnapshotFields', () => {
  test('empty string is a single empty field', () => {
    expect(tokenizeSnapshotFields('', '|')).toEqual(['']);
  });

  test('separator at end yields an empty trailing field', () => {
    expect(tokenizeSnapshotFields('a|b|', '|')).toEqual(['a', 'b', '']);
  });

  test('backslash before separator stays in the previous field', () => {
    expect(tokenizeSnapshotFields('a\\|b', '|')).toEqual(['a\\', 'b']);
  });

  test('consecutive separators yield empty fields', () => {
    expect(tokenizeSnapshotFields('a||b', '|')).toEqual(['a', '', 'b']);
  });
});

describe('foldFlexibleFields', () => {
  test('returns a copy when token count is within the layout', () => {
    expect(foldFlexibleFields(['a', 'b'], FLEXIBLE_FIELD_LAYOUTS[2], '|')).toEqual(['a', 'b']);
  });

  test('joins extras into the flexible middle field', () => {
    expect(foldFlexibleFields(['a', 'b', 'c', 'd'], FLEXIBLE_FIELD_LAYOUTS[2], '|')).toEqual([
      'a',
      'b|c|d',
    ]);
    expect(
      foldFlexibleFields(['@1', '0', 'name', 'with', 'pipe', '1'], FLEXIBLE_FIELD_LAYOUTS[4], '|')
    ).toEqual(['@1', '0', 'name|with|pipe', '1']);
  });
});
