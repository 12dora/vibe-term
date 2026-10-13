import { describe, expect, test } from 'bun:test';
import { EMPTY_SELECTION, EXPLORER_DRAG_MIME, selectOnly } from './model';
import { dirEntry, dragPayload, dropDest, fileEntry } from './test-fixtures';
import { dragPayloadOf, dropActionOf } from './use-explorer-drop';

const transfer = (...types: string[]) => ({ types }) as unknown as DataTransfer;

describe('dropActionOf', () => {
  test('系统文件拖入 → 上传', () => {
    expect(dropActionOf(transfer('Files'), null, dropDest(), false)).toBe('upload');
  });

  test('既不是文件也不是内部拖拽 → 不接受', () => {
    expect(dropActionOf(transfer('text/plain'), null, dropDest(), false)).toBeNull();
  });

  test('内部拖拽：同节点同设备是移动，按住修饰键是复制', () => {
    const dt = transfer(EXPLORER_DRAG_MIME);
    expect(dropActionOf(dt, dragPayload(), dropDest(), false)).toBe('move');
    expect(dropActionOf(dt, dragPayload(), dropDest(), true)).toBe('copy');
  });

  test('内部拖拽：跨设备是复制', () => {
    const dt = transfer(EXPLORER_DRAG_MIME);
    const other = dropDest({ deviceId: 'dev2', rootId: 'r2' });
    expect(dropActionOf(dt, dragPayload(), other, false)).toBe('copy');
  });

  test('内部拖拽：移回原目录、放到自己身上都不接受', () => {
    const dt = transfer(EXPLORER_DRAG_MIME);
    expect(dropActionOf(dt, dragPayload(), dropDest({ dir: '/root' }), false)).toBeNull();
    const folder = dragPayload({ paths: ['/root/sub'], names: ['sub'], hasDirectory: true });
    expect(dropActionOf(dt, folder, dropDest({ dir: '/root/sub' }), false)).toBeNull();
    expect(dropActionOf(dt, folder, dropDest({ dir: '/root/sub/deep' }), true)).toBeNull();
  });

  test('内部拖拽优先于 Files（单文件拖拽会带下载项）', () => {
    const dt = transfer(EXPLORER_DRAG_MIME, 'Files');
    expect(dropActionOf(dt, dragPayload(), dropDest(), false)).toBe('move');
  });

  test('镜像载荷不在（从别的窗口拖来）时先按复制接受', () => {
    expect(dropActionOf(transfer(EXPLORER_DRAG_MIME), null, dropDest(), false)).toBe('copy');
  });
});

describe('dragPayloadOf', () => {
  const entries = [dirEntry('/root/docs'), fileEntry('/root/a.txt'), fileEntry('/root/b.txt')];
  const base = { nodeId: 'self', rootId: 'r1', deviceId: 'dev1', path: '/root', entries };

  test('拖的是选中项：带上整个选择，按列表顺序', () => {
    const selection = {
      selected: new Set(['/root/b.txt', '/root/docs']),
      anchor: '/root/b.txt',
      focus: '/root/b.txt',
    };
    expect(dragPayloadOf(entries[2], { ...base, selection })).toEqual({
      nodeId: 'self',
      rootId: 'r1',
      deviceId: 'dev1',
      dir: '/root',
      paths: ['/root/docs', '/root/b.txt'],
      names: ['docs', 'b.txt'],
      hasDirectory: true,
    });
  });

  test('拖的是未选中项：只带它自己（此时上层的选择状态还没更新）', () => {
    const selection = selectOnly('/root/docs');
    const payload = dragPayloadOf(entries[1], { ...base, selection });
    expect(payload.paths).toEqual(['/root/a.txt']);
    expect(payload.names).toEqual(['a.txt']);
    expect(payload.hasDirectory).toBe(false);
  });

  test('没有任何选择时同样只带被拖的那一项', () => {
    const payload = dragPayloadOf(entries[0], { ...base, selection: EMPTY_SELECTION });
    expect(payload.paths).toEqual(['/root/docs']);
    expect(payload.hasDirectory).toBe(true);
  });
});
