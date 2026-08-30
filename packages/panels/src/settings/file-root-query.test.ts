import { describe, expect, test } from 'bun:test';

import type { ApiClient } from '@tmex/api-client';

import type { FileRootDto } from '@tmex/shared';

import {
  type FileRootDeviceGroup,
  type FileRootEntry,
  collectFileRootClients,
  filterFileRootEntries,
  resolveFileRootClient,
  resolveFileRootsListState,
} from './file-root-query';

function client(id: string): ApiClient {
  return { id } as unknown as ApiClient;
}

describe('resolveFileRootsListState', () => {
  test('查询失败且无数据时进入 error 态（不再伪装成 empty）', () => {
    expect(resolveFileRootsListState({ isLoading: false, isError: true, entryCount: 0 })).toBe(
      'error'
    );
  });

  test('加载中优先于其他状态', () => {
    expect(resolveFileRootsListState({ isLoading: true, isError: false, entryCount: 0 })).toBe(
      'loading'
    );
    expect(resolveFileRootsListState({ isLoading: true, isError: true, entryCount: 0 })).toBe(
      'loading'
    );
  });

  test('成功但无数据时为 empty', () => {
    expect(resolveFileRootsListState({ isLoading: false, isError: false, entryCount: 0 })).toBe(
      'empty'
    );
  });

  test('有数据时渲染列表，后台重取失败也保留旧数据', () => {
    expect(resolveFileRootsListState({ isLoading: false, isError: false, entryCount: 2 })).toBe(
      'ready'
    );
    expect(resolveFileRootsListState({ isLoading: false, isError: true, entryCount: 2 })).toBe(
      'ready'
    );
  });
});

describe('collectFileRootClients', () => {
  const fallback = client('fallback');

  test('未注入分组时只用 runtime 自身的 client', () => {
    expect(collectFileRootClients(undefined, fallback)).toEqual([fallback]);
  });

  test('分组缺省 client 时回落到 runtime，并按引用去重', () => {
    const remote = client('remote');
    const groups: FileRootDeviceGroup[] = [
      { label: 'local', devices: [] },
      { label: 'remote-a', devices: [], apiClient: remote },
      { label: 'remote-b', devices: [], apiClient: remote },
    ];
    expect(collectFileRootClients(groups, fallback)).toEqual([fallback, remote]);
  });

  test('空分组数组不产生任何 client', () => {
    expect(collectFileRootClients([], fallback)).toEqual([]);
  });
});

describe('resolveFileRootClient', () => {
  const fallback = client('fallback');
  const remote = client('remote');
  const groups: FileRootDeviceGroup[] = [
    { label: 'local', devices: [{ id: 'd1', name: 'laptop' }] },
    { label: 'remote', devices: [{ id: 'd2', name: 'server' }], apiClient: remote },
  ];

  test('按设备所属分组挑选落盘 client', () => {
    expect(resolveFileRootClient(groups, fallback, 'd2')).toBe(remote);
    expect(resolveFileRootClient(groups, fallback, 'd1')).toBe(fallback);
  });

  test('设备不属于任何分组或未注入分组时回落', () => {
    expect(resolveFileRootClient(groups, fallback, 'unknown')).toBe(fallback);
    expect(resolveFileRootClient(undefined, fallback, 'd2')).toBe(fallback);
  });
});

describe('filterFileRootEntries', () => {
  const entries: FileRootEntry[] = [
    { root: { id: 'r1', deviceId: 'd1', path: '/a' } as FileRootDto, client: client('c1') },
    { root: { id: 'r2', deviceId: 'd2', path: '/b' } as FileRootDto, client: client('c1') },
  ];

  test('单设备模式只留该设备的 roots', () => {
    expect(filterFileRootEntries(entries, 'd2').map((entry) => entry.root.id)).toEqual(['r2']);
  });

  test('未锁定设备时原样返回', () => {
    expect(filterFileRootEntries(entries, undefined)).toBe(entries);
  });
});
