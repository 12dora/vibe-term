import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import { createGatewaySession, setupConnectionEntry } from './test-helpers';
import { type TmuxCommandHost, handleTermInput, handleTermPaste } from './tmux-command-handlers';
import { handleCanonicalResize } from './tmux-geometry-handlers';
import { handleTmuxSelect } from './tmux-selection-handlers';

function makeSnapshot(): StateSnapshotPayload {
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
              title: 'one',
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

function createHost() {
  const selectPaneCalls: Array<{ windowId: string; paneId: string }> = [];
  const selectPaneWithSizeCalls: Array<{
    windowId: string;
    paneId: string;
    cols: number;
    rows: number;
  }> = [];
  const focusPaneCalls: Array<{ windowId: string; paneId: string }> = [];
  const resizePaneCalls: Array<{ paneId: string; cols: number; rows: number }> = [];
  const flushCalls: string[] = [];

  const runtime = {
    requestSnapshot() {},
    selectPane(windowId: string, paneId: string) {
      selectPaneCalls.push({ windowId, paneId });
    },
    selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number) {
      selectPaneWithSizeCalls.push({ windowId, paneId, cols, rows });
    },
    focusPane(windowId: string, paneId: string) {
      focusPaneCalls.push({ windowId, paneId });
    },
    resizePane(paneId: string, cols: number, rows: number) {
      resizePaneCalls.push({ paneId, cols, rows });
    },
  };

  const connections = new Map();
  const host = {
    connections,
    sendError() {},
    sendEnvelope() {},
    refreshSnapshotPolling(deviceId: string) {
      flushCalls.push(deviceId);
    },
  } as unknown as TmuxCommandHost;

  return {
    host,
    connections,
    runtime,
    selectPaneCalls,
    selectPaneWithSizeCalls,
    focusPaneCalls,
    resizePaneCalls,
    flushCalls,
  };
}

describe('handleTmuxSelect wantHistory', () => {
  test('wantHistory:true 走 selectPane（含 capture）', () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHost();
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleTmuxSelect(fixture.host, ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(3),
      wantHistory: true,
      cols: null,
      rows: null,
    });

    expect(fixture.selectPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);
    expect(fixture.focusPaneCalls).toEqual([]);
    expect(fixture.selectPaneWithSizeCalls).toEqual([]);
    sessionStateStore.delete(ws);
  });

  test('wantHistory:false 走 focusPane，不 capture', () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHost();
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleTmuxSelect(fixture.host, ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(4),
      wantHistory: false,
      cols: null,
      rows: null,
    });

    expect(fixture.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);
    expect(fixture.selectPaneCalls).toEqual([]);
    expect(fixture.selectPaneWithSizeCalls).toEqual([]);
    expect(fixture.resizePaneCalls).toEqual([]);
    sessionStateStore.delete(ws);
  });

  // canonical v1.1：只有 ResizePaneV11(geometryReason=resend) 才不信任快照几何，
  // TMUX_SELECT 一律走去重（canonical 客户端的 wantHistory 恒为 false）。
  test('wantHistory:false 带与快照相同的尺寸时不 resize；随后的 resend 强制下发', () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHost();
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleTmuxSelect(fixture.host, ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(5),
      wantHistory: false,
      cols: 80,
      rows: 24,
    });

    expect(fixture.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);
    expect(fixture.resizePaneCalls).toEqual([]);
    expect(fixture.selectPaneCalls).toEqual([]);
    expect(fixture.selectPaneWithSizeCalls).toEqual([]);

    handleCanonicalResize(fixture.host, ws, {
      deviceId: 'device-a',
      paneId: '%1',
      cols: 80,
      rows: 24,
      reason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
      sizeEpoch: 1n,
    });

    expect(fixture.resizePaneCalls).toEqual([{ paneId: '%1', cols: 80, rows: 24 }]);
    sessionStateStore.delete(ws);
  });

  test('wantHistory:false 带尺寸时 focus + resize，仍不 capture', () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHost();
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleTmuxSelect(fixture.host, ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(5),
      wantHistory: false,
      cols: 100,
      rows: 30,
    });

    expect(fixture.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);
    expect(fixture.resizePaneCalls).toEqual([{ paneId: '%1', cols: 100, rows: 30 }]);
    expect(fixture.selectPaneCalls).toEqual([]);
    expect(fixture.selectPaneWithSizeCalls).toEqual([]);
    sessionStateStore.delete(ws);
  });

  test('wantHistory:true 带尺寸时走 selectPaneWithSize，不拆成无序 select+resize', () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHost();
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleTmuxSelect(fixture.host, ws, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(6),
      wantHistory: true,
      cols: 100,
      rows: 30,
    });

    expect(fixture.selectPaneWithSizeCalls).toEqual([
      { windowId: '@1', paneId: '%1', cols: 100, rows: 30 },
    ]);
    expect(fixture.selectPaneCalls).toEqual([]);
    expect(fixture.resizePaneCalls).toEqual([]);
    expect(fixture.focusPaneCalls).toEqual([]);
    sessionStateStore.delete(ws);
  });
});

describe('handleTermInput / handleTermPaste', () => {
  function inputFixture() {
    const inputs: Array<{ paneId: string; data: string }> = [];
    const fixture = createHost();
    const ws = createGatewaySession({ session: true });
    setupConnectionEntry(
      { connections: fixture.connections },
      {
        ws,
        runtime: {
          ...fixture.runtime,
          sendInput(paneId: string, data: string) {
            inputs.push({ paneId, data });
          },
        },
        lastSnapshot: makeSnapshot(),
      }
    );
    return { host: fixture.host, ws, inputs };
  }

  test('按键逐条透传', () => {
    const { host, ws, inputs } = inputFixture();
    handleTermInput(host, 'device-a', '%1', 'a');
    handleTermInput(host, 'device-a', '%1', 'b');
    expect(inputs).toEqual([
      { paneId: '%1', data: 'a' },
      { paneId: '%1', data: 'b' },
    ]);
    sessionStateStore.delete(ws);
  });

  test('粘贴整段一次交给连接，不再按 1024 字符切块', () => {
    const { host, ws, inputs } = inputFixture();
    const payload = 'p'.repeat(32 * 1024);
    handleTermPaste(host, 'device-a', '%1', payload);
    expect(inputs).toEqual([{ paneId: '%1', data: payload }]);
    sessionStateStore.delete(ws);
  });

  test('设备不存在时不发输入', () => {
    const fixture = createHost();
    handleTermPaste(fixture.host, 'device-missing', '%1', 'x');
    expect(fixture.flushCalls).toEqual([]);
  });
});
