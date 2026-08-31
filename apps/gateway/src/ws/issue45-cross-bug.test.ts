import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { runMigrations } from '../db/migrate';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { WebSocketServer } from './index';
import {
  type BorshTestWs,
  createBorshTestWs,
  envelopeKind,
  setupConnectionEntry,
} from './test-helpers';

// 跨 bug 干扰测试（issue #45 Task 12 场景 2）：bug 2 fix（broadcastTerminalHistory 按
// ACKED 事务 context.paneId 路由）× 正常 pane 切换。
//
// Metis 担心：bug 2 fix 在 broadcastTerminalHistory 前插入了 getTransactionPaneId 分支，
// 可能让正常 pane 切换（无 barrier 事务 / selectedPanes === txPaneId）的 history 路由退化。
//
// 验证点：
//   1. 正常 pane 切换（单 pane session，selectedPanes === txPaneId）：barrier history 仍
//      按 ACKED 事务 context.paneId 正确投递，状态转 HISTORY_APPLIED。
//   2. 多 client 混合：A 有 ACKED 事务（P3），B 有 ACKED 事务（P1）→ broadcast(P3) 仅投递
//      给 A，broadcast(P1) 仅投递给 B，txPaneId 过滤不互相误投（bug 2 fix 的 if-else 分支
//      在多个并发事务下不串扰）。
//   3. 无 ACKED 事务时 getTransactionPaneId 返回 null，不破坏后续 selectedPanes / fetch 分支。

beforeAll(() => {
  runMigrations();
});

function createBorshWs(): BorshTestWs {
  return createBorshTestWs({ session: true });
}

function makeSinglePaneSnapshot(): StateSnapshotPayload {
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
              title: 'sole',
              active: true,
              width: 80,
              height: 24,
            },
          ],
        },
        {
          id: '@2',
          name: 'other',
          index: 1,
          active: false,
          panes: [
            {
              id: '%3',
              windowId: '@2',
              index: 0,
              title: 'other-win',
              active: true,
              width: 80,
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

function startAckedTransaction(
  ws: BorshTestWs,
  deviceId: string,
  windowId: string,
  paneId: string
): Uint8Array {
  const selectToken = new Uint8Array(16).fill(Math.floor(Math.random() * 254) + 1);
  const started = switchBarrier.startTransaction(ws, {
    deviceId,
    windowId,
    paneId,
    selectToken,
    wantHistory: true,
    cols: null,
    rows: null,
  });
  expect(started).toBe(true);
  switchBarrier.sendSwitchAck(ws, deviceId);
  expect(sessionStateStore.getOrCreateSelectTransaction(ws, deviceId)?.state).toBe('ACKED');
  return selectToken;
}

describe('issue45 cross-bug: bug 2 (transaction pane routing) x normal pane switch', () => {
  let ws: BorshTestWs | undefined;

  afterEach(() => {
    if (ws) {
      switchBarrier.cleanupClient(ws);
      sessionStateStore.delete(ws);
      ws = undefined;
    }
  });

  test('normal select to a pane in another window: history routed by ACKED transaction (selectedPanes === txPaneId)', () => {
    const server = new WebSocketServer() as any;
    ws = createBorshWs();
    const snapshot = makeSinglePaneSnapshot();
    setupEntry(server, ws, snapshot);

    // 正常 pane 切换：前端 select-pane 切到 @2/%3，handleTmuxSelect 把 selectedPanes
    // 改为 %3 同时 startTransaction + sendSwitchAck（参见 ws/index.ts:705-728）。
    startAckedTransaction(ws, 'device-a', '@2', '%3');
    ws.data.borshState.selectedPanes['device-a'] = '%3';

    const sentBefore = ws.sent.length;
    server.broadcastTerminalHistory('device-a', '%3', 'OTHER_WIN_HISTORY', false, 0);

    const newSent = ws.sent.slice(sentBefore);
    const kinds = newSent.map(envelopeKind).filter((k) => k !== null) as number[];
    expect(kinds).toContain(wsBorsh.KIND_TERM_HISTORY);
    expect(sessionStateStore.getOrCreateSelectTransaction(ws, 'device-a')?.state).toBe('STABLE');
  });

  test('multiple clients with concurrent ACKED transactions on different panes do not cross-route', () => {
    const server = new WebSocketServer() as any;
    ws = createBorshWs();
    const snapshot = makeSinglePaneSnapshot();
    const entry = setupEntry(server, ws, snapshot);

    // 第二个 client（同 device 多端登录场景）。
    const wsB = createBorshWs();
    entry.clients.add(wsB);

    try {
      // A 切到 %3，B 切到 %1，各自有独立 ACKED 事务。
      startAckedTransaction(ws, 'device-a', '@2', '%3');
      ws.data.borshState.selectedPanes['device-a'] = '%3';

      startAckedTransaction(wsB, 'device-a', '@1', '%1');
      wsB.data.borshState.selectedPanes['device-a'] = '%1';

      const sentBeforeA = ws.sent.length;
      const sentBeforeB = wsB.sent.length;

      // P3 history 到达：只能投递给 A（txPaneId === %3），B 的 txPaneId=%1 不匹配 → continue。
      server.broadcastTerminalHistory('device-a', '%3', 'P3_HISTORY', false, 0);

      const newSentA = ws.sent.slice(sentBeforeA);
      const newSentB = wsB.sent.slice(sentBeforeB);
      const kindsA = newSentA.map(envelopeKind).filter((k) => k !== null) as number[];
      const kindsB = newSentB.map(envelopeKind).filter((k) => k !== null) as number[];

      expect(kindsA).toContain(wsBorsh.KIND_TERM_HISTORY);
      expect(kindsB).not.toContain(wsBorsh.KIND_TERM_HISTORY);

      expect(sessionStateStore.getOrCreateSelectTransaction(ws, 'device-a')?.state).toBe('STABLE');
      expect(sessionStateStore.getOrCreateSelectTransaction(wsB, 'device-a')?.state).toBe('ACKED');

      // 紧接着 P1 history 到达：只能投递给 B，A 的事务已 STABLE（getTransactionPaneId
      // 返回 null），不会误投。
      const sentBeforeA2 = ws.sent.length;
      const sentBeforeB2 = wsB.sent.length;

      server.broadcastTerminalHistory('device-a', '%1', 'P1_HISTORY', false, 0);

      const newSentA2 = ws.sent.slice(sentBeforeA2);
      const newSentB2 = wsB.sent.slice(sentBeforeB2);
      const kindsA2 = newSentA2.map(envelopeKind).filter((k) => k !== null) as number[];
      const kindsB2 = newSentB2.map(envelopeKind).filter((k) => k !== null) as number[];

      // A 事务已 STABLE（非 ACKED）→ getTransactionPaneId 返回 null → 走后续分支：
      // selectedPanes[%3] !== %1 → 不投递（无 pendingHistoryFetches）。
      expect(kindsA2).not.toContain(wsBorsh.KIND_TERM_HISTORY);
      expect(kindsB2).toContain(wsBorsh.KIND_TERM_HISTORY);
      expect(sessionStateStore.getOrCreateSelectTransaction(wsB, 'device-a')?.state).toBe('STABLE');
    } finally {
      switchBarrier.cleanupClient(wsB);
      sessionStateStore.delete(wsB);
    }
  });

  test('getTransactionPaneId returns null without ACKED transaction (does not break selectedPanes branch)', () => {
    const server = new WebSocketServer() as any;
    ws = createBorshWs();
    const snapshot = makeSinglePaneSnapshot();
    setupEntry(server, ws, snapshot);

    // 无 startTransaction：getTransactionPaneId 应返回 null，broadcast 走 selectedPanes 分支。
    ws.data.borshState.selectedPanes['device-a'] = '%1';

    expect(switchBarrier.getTransactionPaneId(ws, 'device-a')).toBeNull();

    // 无 ACKED 事务时 sendTermHistory 内 getPending 返回 null 直接 return（switch-barrier.ts:217），
    // 所以 selectedPanes 匹配也不会发送——但关键是 bug 2 fix 的新分支不会误把无事务 client
    // 当成有事务处理（即不会 continue 跳过 selectedPanes 分支后再误判）。
    const sentBefore = ws.sent.length;
    server.broadcastTerminalHistory('device-a', '%1', 'ORPHAN_HISTORY', false, 0);
    const newSent = ws.sent.slice(sentBefore);
    const kinds = newSent.map(envelopeKind).filter((k) => k !== null) as number[];

    // 无事务 → sendTermHistory 早退，不发 TERM_HISTORY。但路径必须经过 selectedPanes 分支
    // （而非被 txPaneId !== null 误判 continue），即 getTransactionPaneId 正确返回 null。
    expect(kinds).not.toContain(wsBorsh.KIND_TERM_HISTORY);
    expect(switchBarrier.getTransactionPaneId(ws, 'device-a')).toBeNull();
  });
});
