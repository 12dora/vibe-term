import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { runMigrations } from '../db/migrate';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { WebSocketServer } from './index';
import { createBorshTestWs, envelopeKind, setupConnectionEntry } from './test-helpers';

// issue-45 bug 2 TDD 红测
// 根因：apps/gateway/src/ws/index.ts:1304-1308 的 broadcastTerminalHistory 用
//   `client.data.borshState.selectedPanes[deviceId] === paneId` 路由 barrier history。
//   split 翻转后前端 focusPane(P2) 把 selectedPanes[dev] 改为 P2，P1 的 barrier
//   history 落入 fetch 分支（line 1311），因 P1 不是 fetch 目标（无 pendingHistoryFetches）
//   被 continue 丢弃，P1 barrier 事务卡死在 ACKED，老 pane 内容丢失。
// 修复（Task 7）应改为按进行中的 barrier 事务 context.paneId 路由 history，保留
//   switch-barrier.ts:218-237 的 ACKED→HISTORY_APPLIED 状态机与 line 224 的 paneId 过滤器。

beforeAll(() => {
  runMigrations();
});

function createBorshWs(): any {
  return createBorshTestWs({ session: true });
}

function makeSplitSnapshot(): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: {
      id: '$1',
      name: 'tmex',
      windows: [
        {
          id: '@1',
          name: 'main',
          index: 0,
          active: true,
          panes: [
            {
              id: '%1',
              windowId: '@1',
              index: 0,
              title: 'left',
              active: false,
              width: 40,
              height: 24,
            },
            {
              id: '%2',
              windowId: '@1',
              index: 1,
              title: 'right',
              active: true,
              width: 40,
              height: 24,
            },
          ],
        },
      ],
    },
  };
}

function setupEntry(server: any, ws: any, snapshot: StateSnapshotPayload): any {
  return setupConnectionEntry(server, {
    ws,
    lastSnapshot: snapshot,
    runtime: {
      requestSnapshot() {},
      selectPane() {},
      selectPaneWithSize() {},
    },
  });
}

describe('issue-45 bug 2: broadcastTerminalHistory routes barrier history by transaction pane, not selectedPanes', () => {
  let ws: any;

  afterEach(() => {
    if (ws) {
      switchBarrier.cleanupClient(ws);
      sessionStateStore.delete(ws);
      ws = undefined as any;
    }
  });

  test('P1 barrier ACKED + selectedPanes flipped to P2: P1 history still reaches barrier (TERM_HISTORY)', () => {
    const server = new WebSocketServer() as any;
    ws = createBorshWs();
    const snapshot = makeSplitSnapshot();
    setupEntry(server, ws, snapshot);

    const selectToken = new Uint8Array(16).fill(7);

    const started = switchBarrier.startTransaction(ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken,
      wantHistory: true,
      cols: null,
      rows: null,
    });
    expect(started).toBe(true);

    switchBarrier.sendSwitchAck(ws, 'device-a');
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, 'device-a')?.state).toBe('ACKED');

    // bug 2 触发条件：P1 history 到达前，前端 focusPane(P2) 已把 selectedPanes 翻转为 P2
    ws.data.borshState.selectedPanes['device-a'] = '%2';

    const sentBefore = ws.sent.length;

    // 模拟 runtime 回调 onTerminalHistory(P1, data) —— P1 的 barrier history
    server.broadcastTerminalHistory('device-a', '%1', 'P1_HISTORY_DATA', false, 0);

    const newSent = ws.sent.slice(sentBefore);
    const kinds = newSent.map(envelopeKind).filter((k) => k !== null) as number[];
    expect(kinds).toContain(wsBorsh.KIND_TERM_HISTORY);

    expect(sessionStateStore.getOrCreateSelectTransaction(ws, 'device-a')?.state).toBe(
      'HISTORY_APPLIED'
    );
  });
});
