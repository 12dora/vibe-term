// 只测纯逻辑；被测模块间接引入节点运行时，需要先装好 window.storage 再动态导入。

import { describe, expect, test } from 'bun:test';
import type { TransferJobView } from '@vibeterm/panels/files/transfers';
import type { ExplorerTab } from '@vibeterm/stores';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { DialogNodeOption } from '../devices/dialog-nodes';

installWindowStorage();

const { runningNodeJobCount, tabNodeKey, transferSyncNodeIds } = await import(
  './explorer-transfers-popover'
);

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const OFFLINE = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

function job(overrides: Partial<TransferJobView>): TransferJobView {
  return {
    key: 'self:j1',
    kind: 'node',
    nodeId: 'self',
    jobId: 'j1',
    fromNodeId: 'self',
    toNodeId: REMOTE,
    title: 'a.bin',
    state: 'running',
    progress: { transferredBytes: 0, totalBytes: 0, ratePerSec: 0, etaSec: null },
    pct: 0,
    path: null,
    itemStates: [],
    itemsDone: 0,
    itemsTotal: 1,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    cancellable: true,
    ...overrides,
  };
}

function tab(id: string, nodeId: string): ExplorerTab {
  return { id, nodeId, rootId: 'r1', history: ['/srv'], index: 0 };
}

function option(id: string, usable: boolean): DialogNodeOption {
  return { id, meshId: id, name: id, online: usable, loggedIn: true, isSelf: false, usable };
}

describe('runningNodeJobCount', () => {
  test('只数未结束的节点间任务', () => {
    expect(
      runningNodeJobCount([
        job({ key: 'a', state: 'running' }),
        job({ key: 'b', state: 'queued' }),
        job({ key: 'c', state: 'done' }),
        job({ key: 'd', state: 'failed' }),
        job({ key: 'e', state: 'cancelled' }),
        job({ key: 'f', kind: 'upload', state: 'running' }),
        job({ key: 'g', kind: 'download', state: 'running' }),
      ])
    ).toBe(2);
  });

  test('空列表为 0', () => {
    expect(runningNodeJobCount([])).toBe(0);
  });
});

describe('tabNodeKey', () => {
  test('去重并排序，结果与标签页顺序无关', () => {
    const a = tabNodeKey({ t1: tab('t1', 'self'), t2: tab('t2', REMOTE), t3: tab('t3', 'self') });
    const b = tabNodeKey({ t2: tab('t2', REMOTE), t1: tab('t1', 'self') });
    expect(a).toBe(b);
    expect(a.split(',')).toHaveLength(2);
  });

  test('没有标签页时为空串', () => {
    expect(tabNodeKey({})).toBe('');
  });
});

describe('transferSyncNodeIds', () => {
  const options = [option('self', true), option(REMOTE, true), option(OFFLINE, false)];
  const find = (id: string) => options.find((item) => item.id === id);
  const base = { tabNodeKey: '', jobs: [], pendingNodeKey: '', find };

  test('开着标签页的节点里只保留可用的', () => {
    const tabNodeKey = ['self', OFFLINE, REMOTE].join(',');
    expect(transferSyncNodeIds({ ...base, tabNodeKey })).toEqual([REMOTE, 'self'].sort());
  });

  test('源节点的标签页已关：store 里未结束的任务仍把它带进来', () => {
    const jobs = [job({ key: `${REMOTE}:j1`, nodeId: REMOTE, state: 'running' })];
    expect(transferSyncNodeIds({ ...base, tabNodeKey: 'self', jobs })).toEqual(
      [REMOTE, 'self'].sort()
    );
  });

  test('已结束的任务与浏览器上传 / 下载不算', () => {
    const jobs = [
      job({ key: 'a', nodeId: REMOTE, state: 'done' }),
      job({ key: 'b', nodeId: REMOTE, kind: 'upload', state: 'running' }),
    ];
    expect(transferSyncNodeIds({ ...base, jobs })).toEqual([]);
  });

  test('登记表里等着收尾的任务所在节点也算', () => {
    expect(transferSyncNodeIds({ ...base, pendingNodeKey: REMOTE })).toEqual([REMOTE]);
  });

  test('三路取并集并去重', () => {
    const jobs = [job({ key: 'a', nodeId: 'self', state: 'queued' })];
    expect(
      transferSyncNodeIds({ ...base, tabNodeKey: 'self', jobs, pendingNodeKey: `${REMOTE},self` })
    ).toEqual([REMOTE, 'self'].sort());
  });

  test('空串、不可用与已不在目录里的节点都不产生请求', () => {
    expect(transferSyncNodeIds(base)).toEqual([]);
    expect(transferSyncNodeIds({ ...base, tabNodeKey: 'gone', pendingNodeKey: OFFLINE })).toEqual(
      []
    );
  });
});
