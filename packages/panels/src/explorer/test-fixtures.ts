// 组合层单测共用的条目 / 载荷构造器。

import type { FileEntryDto } from '@vibeterm/shared';
import type { ExplorerDragPayload, ExplorerDropDest } from './model';

export function fileEntry(path: string, size: number | null = 10): FileEntryDto {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    type: 'file',
    category: 'text',
    size,
    modifiedAt: null,
    isSymlink: false,
  };
}

export function dirEntry(path: string): FileEntryDto {
  return { ...fileEntry(path, null), type: 'dir', category: 'directory' };
}

export function dragPayload(patch: Partial<ExplorerDragPayload> = {}): ExplorerDragPayload {
  return {
    nodeId: 'self',
    rootId: 'r1',
    deviceId: 'dev1',
    dir: '/root',
    paths: ['/root/a.txt'],
    names: ['a.txt'],
    hasDirectory: false,
    ...patch,
  };
}

export function dropDest(patch: Partial<ExplorerDropDest> = {}): ExplorerDropDest {
  return { nodeId: 'self', deviceId: 'dev1', rootId: 'r1', dir: '/root/sub', ...patch };
}
