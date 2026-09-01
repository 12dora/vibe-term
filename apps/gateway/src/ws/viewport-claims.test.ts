import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { WebSocketServer } from './index';
import { createGatewaySession, setupConnectionEntry } from './test-helpers';
import { applyViewportPolicy } from './tmux-command-handlers';

function decodePolicies(session: ReturnType<typeof createGatewaySession>) {
  return session.sent.flatMap((bytes) => {
    const envelope = wsBorsh.decodeEnvelope(bytes);
    if (envelope.kind !== wsBorsh.KIND_TERM_VIEWPORT_POLICY) return [];
    return [wsBorsh.decodePayload(wsBorsh.schema.TermViewportPolicySchema, envelope.payload)];
  });
}

function lastPolicy(session: ReturnType<typeof createGatewaySession>) {
  return decodePolicies(session).at(-1);
}

function createResizeRecorder() {
  const recorder = {
    resizeWindowCalls: [] as Array<[string, number, number]>,
    resizePaneCalls: [] as Array<[string, number, number]>,
    selectPaneCalls: [] as Array<{ windowId: string; paneId: string }>,
    selectPaneWithSizeCalls: [] as Array<{
      windowId: string;
      paneId: string;
      cols: number;
      rows: number;
    }>,
    focusPaneCalls: [] as Array<{ windowId: string; paneId: string }>,
    runtime: {
      resizeWindow(windowId: string, cols: number, rows: number) {
        recorder.resizeWindowCalls.push([windowId, cols, rows]);
      },
      resizePane(paneId: string, cols: number, rows: number) {
        recorder.resizePaneCalls.push([paneId, cols, rows]);
      },
      selectPane(windowId: string, paneId: string) {
        recorder.selectPaneCalls.push({ windowId, paneId });
      },
      selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number) {
        recorder.selectPaneWithSizeCalls.push({ windowId, paneId, cols, rows });
      },
      focusPane(windowId: string, paneId: string) {
        recorder.focusPaneCalls.push({ windowId, paneId });
      },
      requestSnapshot() {},
    },
  };
  return recorder;
}

function pane(id: string, windowId: string, index: number, width = 80, height = 24) {
  return {
    id,
    windowId,
    index,
    title: 't',
    active: index === 0,
    width,
    height,
  };
}

function snapshot(
  windows: NonNullable<StateSnapshotPayload['session']>['windows']
): StateSnapshotPayload {
  return {
    deviceId: 'device-a',
    session: { id: '$1', name: 'tmex', windows },
  };
}

function setupTwoClients(options: { paneCount?: number; session?: boolean } = {}) {
  const server = new WebSocketServer();
  const recorder = createResizeRecorder();
  const large = createGatewaySession({ id: 'sess-large', session: options.session });
  const small = createGatewaySession({ id: 'sess-small', session: options.session });
  const panes =
    options.paneCount === 2 ? [pane('%0', '@1', 0), pane('%1', '@1', 1)] : [pane('%0', '@1', 0)];
  const entry = setupConnectionEntry(server, {
    deviceId: 'device-a',
    runtime: recorder.runtime,
    clients: new Set([large, small]),
    lastSnapshot: snapshot([
      {
        id: '@1',
        name: 'w1',
        index: 0,
        active: true,
        panes,
      },
    ]),
  });
  return { server, recorder, large, small, entry };
}

function cleanupSelectSessions(...sessions: Array<ReturnType<typeof createGatewaySession>>): void {
  for (const session of sessions) {
    switchBarrier.cleanupClient(session);
    sessionStateStore.delete(session);
  }
}

describe('viewport claims', () => {
  test('larger visible client owns the size; both receive policy', () => {
    const { server, recorder, large, small } = setupTwoClients();

    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    server.handleTermResize(small, 'device-a', '%0', 80, 24);

    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%0',
      owner: true,
      cols: 160,
      rows: 48,
    });
    expect(lastPolicy(small)).toMatchObject({
      owner: false,
      cols: 160,
      rows: 48,
      paneId: '%0',
    });
  });

  test('larger going hidden applies the smaller geometry and flips owners', () => {
    const { server, recorder, large, small } = setupTwoClients();
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    recorder.resizePaneCalls.length = 0;

    server.handleTermViewport(large, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 160,
      rows: 48,
      visible: false,
    });

    expect(recorder.resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(lastPolicy(small)?.owner).toBe(true);
    expect(lastPolicy(small)).toMatchObject({ cols: 80, rows: 24 });
    expect(lastPolicy(large)?.owner).toBe(false);
  });

  test('larger disconnect applies the smaller geometry', () => {
    const { server, recorder, large, small, entry } = setupTwoClients();
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    recorder.resizePaneCalls.length = 0;

    entry.clients.delete(large);
    server.dropViewportClaims(large);

    expect(recorder.resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(lastPolicy(small)?.owner).toBe(true);
    expect(lastPolicy(small)).toMatchObject({ cols: 80, rows: 24 });
  });

  test('smaller-only applies as today', () => {
    const { server, recorder, small } = setupTwoClients();
    server.handleTermResize(small, 'device-a', '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
    expect(lastPolicy(small)?.owner).toBe(true);
  });

  test('legacy resize-only client is a visible claimant', () => {
    const { server, recorder, large, small } = setupTwoClients();
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    server.handleTermViewport(small, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });

    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(small)?.owner).toBe(false);
    expect(lastPolicy(small)).toMatchObject({ cols: 160, rows: 48 });
  });

  test('unknown pane viewport claim is ignored', () => {
    const { server, recorder, large } = setupTwoClients();
    server.handleTermViewport(large, {
      deviceId: 'device-a',
      paneId: '%missing',
      cols: 200,
      rows: 60,
      visible: true,
    });
    expect(recorder.resizePaneCalls).toEqual([]);
    expect(large.viewportClaims.size).toBe(0);
    expect(decodePolicies(large)).toEqual([]);
  });

  test('device detach drops claims and recomputes', () => {
    const { server, recorder, large, small } = setupTwoClients();
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    recorder.resizePaneCalls.length = 0;

    server.handleDeviceDisconnect(large, 'device-a');

    expect(large.viewportClaims.size).toBe(0);
    expect(recorder.resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(lastPolicy(small)?.owner).toBe(true);
  });

  test('reconnect-failure drops claims without resizing', () => {
    const { server, recorder, large, small, entry } = setupTwoClients();
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    recorder.resizePaneCalls.length = 0;

    server.dropViewportClaims(large, 'device-a', { recompute: false });
    server.dropViewportClaims(small, 'device-a', { recompute: false });
    entry.clients.clear();

    expect(large.viewportClaims.size).toBe(0);
    expect(small.viewportClaims.size).toBe(0);
    expect(recorder.resizePaneCalls).toEqual([]);
  });

  test('sized follower TMUX_SELECT does not resize; owner select applies', () => {
    const { server, recorder, large, small } = setupTwoClients({
      paneCount: 2,
      session: true,
    });
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    recorder.resizeWindowCalls.length = 0;
    recorder.resizePaneCalls.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;

    server.handleTmuxSelect(small, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: false,
      cols: 80,
      rows: 24,
    });

    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    expect(recorder.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);

    server.handleTmuxSelect(large, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(2),
      wantHistory: false,
      cols: 200,
      rows: 50,
    });

    expect(recorder.resizeWindowCalls).toEqual([['@1', 200, 50]]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    cleanupSelectSessions(large, small);
  });

  test('repeated sync after out-of-band tmux resize is applied', () => {
    const { server, recorder, large, entry } = setupTwoClients();
    server.handleTermResize(large, 'device-a', '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
    recorder.resizePaneCalls.length = 0;

    const livePane = entry.lastSnapshot?.session?.windows[0]?.panes[0];
    expect(livePane).toBeDefined();
    if (!livePane) return;
    livePane.width = 40;
    livePane.height = 12;

    server.handleTermResize(large, 'device-a', '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
  });

  test('follower pane switch on the same window sends policy for the new pane', () => {
    const { server, large, small } = setupTwoClients({ paneCount: 2 });
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    server.handleTermResize(small, 'device-a', '%0', 80, 24);
    small.sent.length = 0;

    server.handleTermResize(small, 'device-a', '%1', 80, 24);

    expect(lastPolicy(small)).toMatchObject({
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 160,
      rows: 48,
    });
  });

  test('claim keyed to a window is dropped after its pane moves; the new window is not resized', () => {
    const { server, recorder, large, entry } = setupTwoClients();
    server.handleTermResize(large, 'device-a', '%0', 160, 48);
    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    recorder.resizePaneCalls.length = 0;
    recorder.resizeWindowCalls.length = 0;
    entry.lastAppliedViewport?.delete('@1');

    entry.lastSnapshot = snapshot([
      {
        id: '@2',
        name: 'w2',
        index: 0,
        active: true,
        panes: [pane('%0', '@2', 0, 80, 24)],
      },
    ]);

    applyViewportPolicy(server, 'device-a', '@1');

    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(large.viewportClaims.has('device-a/@1')).toBe(false);
    expect(entry.lastAppliedViewport?.has('@1')).toBe(false);
  });
});
