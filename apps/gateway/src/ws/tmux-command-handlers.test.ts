import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { createGatewaySession, setupConnectionEntry } from './test-helpers';
import {
  type TmuxCommandHost,
  handleFetchPaneHistory,
  handleTmuxSelect,
} from './tmux-command-handlers';

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
    terminalOutputBatcher: {
      flushDevice(deviceId: string) {
        flushCalls.push(deviceId);
      },
    },
    sendError() {},
    sendEnvelope() {},
    syncLegacyPaneObservers() {},
    refreshSnapshotPolling() {},
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
    switchBarrier.cleanupClient(ws);
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
    switchBarrier.cleanupClient(ws);
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
    switchBarrier.cleanupClient(ws);
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
    switchBarrier.cleanupClient(ws);
    sessionStateStore.delete(ws);
  });
});

describe('handleFetchPaneHistory byteLimit', () => {
  const TOKEN = new Uint8Array(16).fill(9);

  function createHistoryHost(data: string) {
    const fetchCalls: Array<{ paneId: string; byteLimit?: number }> = [];
    const chunks: Uint8Array[] = [];
    const runtime = {
      fetchPaneHistory(paneId: string, byteLimit?: number) {
        fetchCalls.push({ paneId, byteLimit });
        return Promise.resolve({
          data,
          alternateScreen: false,
          modes: 0,
        });
      },
    };
    const connections = new Map();
    const host = {
      connections,
      sendChunked(_session: unknown, kind: number, payload: Uint8Array) {
        expect(kind).toBe(wsBorsh.KIND_TERM_HISTORY);
        chunks.push(payload);
        return true;
      },
    } as unknown as TmuxCommandHost;
    return { host, connections, runtime, fetchCalls, chunks };
  }

  test('passes byteLimit into fetch and hard-truncates the encoded tail', async () => {
    const ws = createGatewaySession({ session: true });
    const body = `HEAD${'X'.repeat(40)}TAIL`;
    const fixture = createHistoryHost(body);
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleFetchPaneHistory(fixture.host, ws, 'device-a', '%1', TOKEN, 8);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(fixture.fetchCalls).toEqual([{ paneId: '%1', byteLimit: 8 }]);
    expect(fixture.chunks).toHaveLength(1);
    const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, fixture.chunks[0]!);
    const text = new TextDecoder().decode(decoded.data);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(decoded.data.byteLength).toBeLessThanOrEqual(8);
    expect(text.includes('HEAD')).toBe(false);
  });

  test('legacy requests without byteLimit still fetch and send history', async () => {
    const ws = createGatewaySession({ session: true });
    const fixture = createHistoryHost('full-screen');
    setupConnectionEntry(
      { connections: fixture.connections },
      { ws, runtime: fixture.runtime, lastSnapshot: makeSnapshot() }
    );

    handleFetchPaneHistory(fixture.host, ws, 'device-a', '%1', TOKEN);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(fixture.fetchCalls[0]?.paneId).toBe('%1');
    expect(fixture.chunks).toHaveLength(1);
    const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, fixture.chunks[0]!);
    expect(new TextDecoder().decode(decoded.data)).toBe('full-screen');
  });
});
