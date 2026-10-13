// 登记表的收尾：终态摘除、进行中保留、行被清掉时静默丢弃。
// 被测模块引入节点运行时，需要先装好 window.storage 再动态导入。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { TransferJobView } from '@vibeterm/panels/files/transfers';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { TFunction } from 'i18next';

installWindowStorage();

const { putTransferJobView, resetTransferJobsForTest, transferJobKey } = await import(
  '@vibeterm/panels/files/transfers'
);
const {
  pendingExplorerTransferCount,
  registerExplorerTransfer,
  resetExplorerTransfersForTest,
  settleExplorerTransfers,
} = await import('./use-explorer-transfer-watch');

const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';
const RECORD = { destNodeId: REMOTE, destRootId: 'r9', destDir: '/data', count: 2 };

let translated: string[] = [];
const t = ((key: string) => {
  translated.push(key);
  return key;
}) as unknown as TFunction;

function view(jobId: string, overrides: Partial<TransferJobView> = {}): TransferJobView {
  return {
    key: transferJobKey('self', jobId),
    kind: 'node',
    nodeId: 'self',
    jobId,
    fromNodeId: 'self',
    toNodeId: REMOTE,
    title: 'a.bin',
    state: 'running',
    progress: { transferredBytes: 0, totalBytes: 0, ratePerSec: 0, etaSec: null },
    pct: 0,
    path: null,
    itemStates: [],
    itemsDone: 0,
    itemsTotal: 2,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    cancellable: true,
    ...overrides,
  };
}

beforeEach(() => {
  resetTransferJobsForTest();
  resetExplorerTransfersForTest();
  translated = [];
});

describe('settleExplorerTransfers', () => {
  test('进行中的任务留在登记表里，不出文案', () => {
    putTransferJobView(view('j1'));
    registerExplorerTransfer(transferJobKey('self', 'j1'), RECORD);
    settleExplorerTransfers(t);
    expect(pendingExplorerTransferCount()).toBe(1);
    expect(translated).toEqual([]);
  });

  test('完成：摘除并报一次成功', () => {
    putTransferJobView(view('j1', { state: 'done', itemStates: ['done', 'done'] }));
    registerExplorerTransfer(transferJobKey('self', 'j1'), RECORD);
    settleExplorerTransfers(t);
    settleExplorerTransfers(t);
    expect(pendingExplorerTransferCount()).toBe(0);
    expect(translated).toEqual(['explorer.transfer.done']);
  });

  test('失败：报失败并带错误码文案', () => {
    putTransferJobView(view('j1', { state: 'failed', error: 'permission_denied' }));
    registerExplorerTransfer(transferJobKey('self', 'j1'), RECORD);
    settleExplorerTransfers(t);
    expect(pendingExplorerTransferCount()).toBe(0);
    expect(translated).toEqual([
      'explorer.transfer.failed',
      'devices.transfer.errors.permission_denied',
    ]);
  });

  test('全部被跳过：按「目标已存在」报未完成', () => {
    putTransferJobView(view('j1', { state: 'done', itemStates: ['skipped', 'skipped'] }));
    registerExplorerTransfer(transferJobKey('self', 'j1'), RECORD);
    settleExplorerTransfers(t);
    expect(translated).toEqual(['explorer.transfer.failed', 'devices.transfer.errors.dest_exists']);
  });

  test('取消：摘除但不出文案', () => {
    putTransferJobView(view('j1', { state: 'cancelled' }));
    registerExplorerTransfer(transferJobKey('self', 'j1'), RECORD);
    settleExplorerTransfers(t);
    expect(pendingExplorerTransferCount()).toBe(0);
    expect(translated).toEqual([]);
  });

  test('行已被清掉：静默丢弃登记', () => {
    registerExplorerTransfer(transferJobKey('self', 'gone'), RECORD);
    settleExplorerTransfers(t);
    expect(pendingExplorerTransferCount()).toBe(0);
    expect(translated).toEqual([]);
  });

  test('只收尾登记过的任务', () => {
    putTransferJobView(view('other', { state: 'done', itemStates: ['done'] }));
    settleExplorerTransfers(t);
    expect(translated).toEqual([]);
  });
});
