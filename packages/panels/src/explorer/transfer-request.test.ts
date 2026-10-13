import { describe, expect, test } from 'bun:test';
import type { ExplorerClipboard } from '@vibeterm/stores';
import { dragPayload, dropDest } from './test-fixtures';
import { clipboardSource, requestFromClipboard, requestFromDrop } from './transfer-request';

function clipboard(patch: Partial<ExplorerClipboard> = {}): ExplorerClipboard {
  return {
    mode: 'copy',
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'dev1',
    paths: ['/root/a.txt', '/root/docs'],
    ...patch,
  };
}

const NAMES = ['a.txt', 'docs'];

describe('requestFromDrop', () => {
  test('原样带上载荷、目标、语义与已知名称，不带 cut', () => {
    const source = dragPayload();
    const dest = dropDest();
    const names = new Set(['a.txt']);
    expect(requestFromDrop(source, dest, 'move', names)).toEqual({
      source,
      dest,
      kind: 'move',
      destNames: names,
    });
    expect(requestFromDrop(source, dest, 'copy', null).destNames).toBeNull();
  });
});

describe('clipboardSource', () => {
  test('所在目录取第一项的父目录', () => {
    expect(clipboardSource(clipboard(), NAMES, true)).toEqual({
      nodeId: 'self',
      rootId: 'r1',
      deviceId: 'dev1',
      dir: '/root',
      paths: ['/root/a.txt', '/root/docs'],
      names: NAMES,
      hasDirectory: true,
    });
    expect(clipboardSource(clipboard({ paths: ['/a.txt'] }), ['a.txt'], false).dir).toBe('/');
  });

  test('路径数组是副本，不与剪贴板共用引用', () => {
    const source = clipboard();
    expect(clipboardSource(source, NAMES, true).paths).not.toBe(source.paths);
  });
});

describe('requestFromClipboard', () => {
  test('复制 → copy，不带 cut', () => {
    const request = requestFromClipboard(clipboard(), NAMES, true, dropDest(), null);
    expect(request?.kind).toBe('copy');
    expect(request?.cut).toBeUndefined();
    expect(request?.dest).toEqual(dropDest());
  });

  test('剪切到同节点同设备 → move，带 cut', () => {
    const names = new Set(['x']);
    const request = requestFromClipboard(
      clipboard({ mode: 'cut' }),
      NAMES,
      true,
      dropDest(),
      names
    );
    expect(request?.kind).toBe('move');
    expect(request?.cut).toBe(true);
    expect(request?.destNames).toBe(names);
  });

  test('剪切到另一设备或另一节点 → 退化为 copy，仍带 cut', () => {
    const cut = clipboard({ mode: 'cut' });
    const otherDevice = requestFromClipboard(
      cut,
      NAMES,
      true,
      dropDest({ deviceId: 'dev2', rootId: 'r2' }),
      null
    );
    expect(otherDevice?.kind).toBe('copy');
    expect(otherDevice?.cut).toBe(true);
    const otherNode = requestFromClipboard(cut, NAMES, true, dropDest({ nodeId: 'n2' }), null);
    expect(otherNode?.kind).toBe('copy');
    expect(otherNode?.cut).toBe(true);
  });

  test('剪切后粘回原目录是空操作', () => {
    const request = requestFromClipboard(
      clipboard({ mode: 'cut' }),
      NAMES,
      true,
      dropDest({ dir: '/root' }),
      null
    );
    expect(request).toBeNull();
  });

  test('复制后粘回原目录仍然放行（由宿主走冲突流程）', () => {
    const dest = dropDest({ dir: '/root' });
    expect(requestFromClipboard(clipboard(), NAMES, true, dest, null)?.kind).toBe('copy');
  });

  test('目录不能粘进自身或其子孙，复制与剪切都一样', () => {
    for (const mode of ['copy', 'cut'] as const) {
      const source = clipboard({ mode });
      expect(
        requestFromClipboard(source, NAMES, true, dropDest({ dir: '/root/docs' }), null)
      ).toBeNull();
      expect(
        requestFromClipboard(source, NAMES, true, dropDest({ dir: '/root/docs/deep' }), null)
      ).toBeNull();
    }
  });

  test('同名前缀的兄弟目录不算子孙', () => {
    const request = requestFromClipboard(
      clipboard({ mode: 'cut' }),
      NAMES,
      true,
      dropDest({ dir: '/root/docs-2' }),
      null
    );
    expect(request?.kind).toBe('move');
  });

  test('另一个根上的同名路径不受自身 / 子孙规则限制', () => {
    const request = requestFromClipboard(
      clipboard({ mode: 'cut' }),
      NAMES,
      true,
      dropDest({ rootId: 'r2', dir: '/root/docs' }),
      null
    );
    expect(request?.kind).toBe('move');
  });

  test('剪贴板为空或名称数量对不上时不产生请求', () => {
    expect(requestFromClipboard(clipboard({ paths: [] }), [], false, dropDest(), null)).toBeNull();
    expect(requestFromClipboard(clipboard(), ['a.txt'], true, dropDest(), null)).toBeNull();
  });
});
