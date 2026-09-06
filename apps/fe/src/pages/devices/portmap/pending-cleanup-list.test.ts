// 待清理放行行的展示名与可重试判定。

import { describe, expect, test } from 'bun:test';
import type { DialogNodeOption } from '../dialog-nodes';
import type { PendingExportCleanup } from './pending-cleanup';
import { cleanupNodeName, cleanupRetryable } from './pending-cleanup-list';

const ENTRY = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';
const REMOTE = '0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f';

const RECORD: PendingExportCleanup = {
  mapId: 'm1',
  listenMeshId: ENTRY,
  targetMeshId: REMOTE,
  label: '8080',
  confirmed: true,
  createdAt: 1,
};

function option(overrides: Partial<DialogNodeOption> = {}): DialogNodeOption {
  return {
    id: REMOTE,
    meshId: REMOTE,
    name: 'studio',
    online: true,
    loggedIn: true,
    isSelf: false,
    usable: true,
    ...overrides,
  };
}

describe('cleanupNodeName', () => {
  test('按 mesh id 找节点名，找不到退回短 id', () => {
    expect(cleanupNodeName(RECORD, [option()])).toBe('studio');
    expect(cleanupNodeName(RECORD, [])).toBe(REMOTE.slice(0, 8));
  });
});

describe('cleanupRetryable', () => {
  test('目标节点在线且已登录才能重试', () => {
    expect(cleanupRetryable(RECORD, [option()])).toBe(true);
    expect(cleanupRetryable(RECORD, [option({ usable: false })])).toBe(false);
    expect(cleanupRetryable(RECORD, [])).toBe(false);
  });
});
