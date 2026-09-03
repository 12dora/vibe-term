import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import { WebSocketServer } from './index';
import { createGatewaySession, setupConnectionEntry } from './test-helpers';

let sizeEpochCounter = 0n;

/** canonical v1.1 尺寸变更（reason=change），每次调用推进一次 epoch。 */
function termResize(
  server: any,
  session: ReturnType<typeof createGatewaySession>,
  paneId: string,
  cols: number,
  rows: number
): void {
  sizeEpochCounter += 1n;
  server.handleCanonicalResize(session, {
    deviceId: 'device-a',
    paneId,
    cols,
    rows,
    reason: wsBorsh.CANONICAL_GEOMETRY_REASON_CHANGE,
    sizeEpoch: sizeEpochCounter,
  });
}

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
    ops: [] as string[],
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
        recorder.ops.push(`resizeWindow:${windowId}:${cols}x${rows}`);
      },
      resizePane(paneId: string, cols: number, rows: number) {
        recorder.resizePaneCalls.push([paneId, cols, rows]);
        recorder.ops.push(`resizePane:${paneId}:${cols}x${rows}`);
      },
      selectPane(windowId: string, paneId: string) {
        recorder.selectPaneCalls.push({ windowId, paneId });
        recorder.ops.push(`selectPane:${windowId}:${paneId}`);
        recorder.ops.push('capture');
      },
      selectPaneWithSize(windowId: string, paneId: string, cols: number, rows: number) {
        recorder.selectPaneWithSizeCalls.push({ windowId, paneId, cols, rows });
        recorder.ops.push(`resize:${cols}x${rows}`);
        recorder.ops.push(`selectPane:${windowId}:${paneId}`);
        recorder.ops.push('capture');
      },
      focusPane(windowId: string, paneId: string) {
        recorder.focusPaneCalls.push({ windowId, paneId });
        recorder.ops.push(`focusPane:${windowId}:${paneId}`);
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
  const server = new WebSocketServer({
    deps: {
      loadDeviceTreeOrder: (deviceId: string) => ({
        deviceId,
        windows: [],
        panes: {},
      }),
    },
  });
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
    sessionStateStore.delete(session);
  }
}

function sizedSelect(
  paneId: string,
  cols: number,
  rows: number,
  token: number,
  wantHistory = true
) {
  return {
    deviceId: 'device-a',
    windowId: '@1',
    paneId,
    selectToken: new Uint8Array(16).fill(token),
    wantHistory,
    cols,
    rows,
  };
}

function expectResizeBeforeCapture(ops: string[], size: string): void {
  const resizeAt = ops.indexOf(`resize:${size}`);
  const captureAt = ops.indexOf('capture');
  expect(resizeAt).toBeGreaterThanOrEqual(0);
  expect(captureAt).toBeGreaterThan(resizeAt);
  expect(ops.slice(0, captureAt).some((op) => op.startsWith('resizePane:'))).toBe(false);
  expect(ops.slice(0, captureAt).some((op) => op.startsWith('resizeWindow:'))).toBe(false);
}

describe('viewport claims', () => {
  test('smallest visible client owns the size; both receive that policy', () => {
    const { server, recorder, large, small } = setupTwoClients();

    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);

    expect(recorder.resizePaneCalls).toEqual([
      ['%0', 160, 48],
      ['%0', 80, 24],
    ]);
    expect(lastPolicy(large)).toMatchObject({
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%0',
      owner: false,
      cols: 80,
      rows: 24,
    });
    expect(lastPolicy(small)).toMatchObject({
      owner: true,
      cols: 80,
      rows: 24,
      paneId: '%0',
    });
  });

  test('smaller going hidden applies the larger geometry and flips owners', () => {
    const { server, recorder, large, small } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    recorder.resizePaneCalls.length = 0;

    server.handleTermViewport(small, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: false,
    });

    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)?.owner).toBe(true);
    expect(lastPolicy(large)).toMatchObject({ cols: 160, rows: 48 });
    expect(lastPolicy(small)?.owner).toBe(false);
  });

  test('smaller disconnect applies the larger geometry', () => {
    const { server, recorder, large, small, entry } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    recorder.resizePaneCalls.length = 0;

    entry.clients.delete(small);
    server.dropViewportClaims(small);

    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)?.owner).toBe(true);
    expect(lastPolicy(large)).toMatchObject({ cols: 160, rows: 48 });
  });

  test('smaller-only applies as today', () => {
    const { server, recorder, small } = setupTwoClients();
    termResize(server, small, '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
    expect(lastPolicy(small)?.owner).toBe(true);
  });

  test('legacy resize-only client is a visible claimant', () => {
    const { server, recorder, large, small } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    server.handleTermViewport(small, {
      deviceId: 'device-a',
      paneId: '%0',
      cols: 80,
      rows: 24,
      visible: true,
    });

    expect(recorder.resizePaneCalls).toEqual([
      ['%0', 160, 48],
      ['%0', 80, 24],
    ]);
    expect(lastPolicy(small)?.owner).toBe(true);
    expect(lastPolicy(small)).toMatchObject({ cols: 80, rows: 24 });
    expect(lastPolicy(large)?.owner).toBe(false);
    expect(lastPolicy(large)).toMatchObject({ cols: 80, rows: 24 });
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
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    recorder.resizePaneCalls.length = 0;

    server.handleDeviceDisconnect(small, 'device-a');

    expect(small.viewportClaims.size).toBe(0);
    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)?.owner).toBe(true);
  });

  test('reconnect-failure drops claims without resizing', () => {
    const { server, recorder, large, small, entry } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
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
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    recorder.resizeWindowCalls.length = 0;
    recorder.resizePaneCalls.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;

    server.handleTmuxSelect(large, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(1),
      wantHistory: false,
      cols: 200,
      rows: 50,
    });

    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    expect(recorder.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);

    server.handleTmuxSelect(small, {
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: new Uint8Array(16).fill(2),
      wantHistory: false,
      cols: 70,
      rows: 20,
    });

    expect(recorder.resizeWindowCalls).toEqual([['@1', 70, 20]]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    cleanupSelectSessions(large, small);
  });

  test('repeated sync after out-of-band tmux resize is applied', () => {
    const { server, recorder, large, entry } = setupTwoClients();
    termResize(server, large, '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
    recorder.resizePaneCalls.length = 0;

    const livePane = entry.lastSnapshot?.session?.windows[0]?.panes[0];
    expect(livePane).toBeDefined();
    if (!livePane) return;
    livePane.width = 40;
    livePane.height = 12;

    termResize(server, large, '%0', 100, 30);
    expect(recorder.resizePaneCalls).toEqual([['%0', 100, 30]]);
  });

  test('follower pane switch on the same window sends policy for the new pane', () => {
    const { server, large, small } = setupTwoClients({ paneCount: 2 });
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    large.sent.length = 0;

    termResize(server, large, '%1', 160, 48);

    expect(lastPolicy(large)).toMatchObject({
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      owner: false,
      cols: 80,
      rows: 24,
    });
  });

  test('owning sized cold select resizes before history capture', () => {
    const { server, recorder, large } = setupTwoClients({ session: true });
    recorder.ops.length = 0;

    server.handleTmuxSelect(large, sizedSelect('%0', 100, 30, 7));

    expect(recorder.selectPaneWithSizeCalls).toEqual([
      { windowId: '@1', paneId: '%0', cols: 100, rows: 30 },
    ]);
    expect(recorder.selectPaneCalls).toEqual([]);
    expectResizeBeforeCapture(recorder.ops, '100x30');
    cleanupSelectSessions(large);
  });

  test('owning sized warm select still resizes when this window has never been applied', () => {
    const { server, recorder, large } = setupTwoClients({ session: true });
    recorder.resizePaneCalls.length = 0;
    recorder.focusPaneCalls.length = 0;

    server.handleTmuxSelect(large, sizedSelect('%0', 80, 24, 12, false));

    expect(recorder.focusPaneCalls).toEqual([{ windowId: '@1', paneId: '%0' }]);
    expect(recorder.resizePaneCalls).toEqual([['%0', 80, 24]]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    cleanupSelectSessions(large);
  });

  test('warm select onto a second window resizes even when its snapshot already matches the claim', () => {
    const { server, recorder, large, entry } = setupTwoClients({ session: true });
    entry.lastSnapshot = snapshot([
      {
        id: '@1',
        name: 'w1',
        index: 0,
        active: true,
        panes: [pane('%0', '@1', 0, 80, 24)],
      },
      {
        id: '@2',
        name: 'w2',
        index: 1,
        active: false,
        panes: [pane('%1', '@2', 0, 80, 24)],
      },
    ]);
    termResize(server, large, '%0', 80, 24);
    recorder.resizePaneCalls.length = 0;
    recorder.focusPaneCalls.length = 0;

    server.handleTmuxSelect(large, {
      ...sizedSelect('%1', 80, 24, 13, false),
      windowId: '@2',
    });

    expect(recorder.focusPaneCalls).toEqual([{ windowId: '@2', paneId: '%1' }]);
    expect(recorder.resizePaneCalls).toEqual([['%1', 80, 24]]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    cleanupSelectSessions(large);
  });

  test('owning sized cold select still resizes when cached geometry already matches (tmux drifted)', () => {
    const { server, recorder, large, entry } = setupTwoClients({ session: true });
    termResize(server, large, '%0', 100, 30);
    const livePane = entry.lastSnapshot?.session?.windows[0]?.panes[0];
    expect(livePane).toMatchObject({ width: 100, height: 30 });
    recorder.ops.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;
    recorder.resizePaneCalls.length = 0;

    server.handleTmuxSelect(large, sizedSelect('%0', 100, 30, 8));

    expect(recorder.selectPaneWithSizeCalls).toEqual([
      { windowId: '@1', paneId: '%0', cols: 100, rows: 30 },
    ]);
    expectResizeBeforeCapture(recorder.ops, '100x30');
    cleanupSelectSessions(large);
  });

  test('owning sized cold select after reconnect still uses ordered selectPaneWithSize', () => {
    const { server, recorder, large, entry } = setupTwoClients({ session: true });
    termResize(server, large, '%0', 100, 30);
    server.handleDeviceDisconnect(large, 'device-a');
    entry.clients.add(large);
    recorder.ops.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;
    recorder.resizePaneCalls.length = 0;

    server.handleTmuxSelect(large, sizedSelect('%0', 100, 30, 9));

    expect(recorder.selectPaneWithSizeCalls).toEqual([
      { windowId: '@1', paneId: '%0', cols: 100, rows: 30 },
    ]);
    expect(recorder.selectPaneCalls).toEqual([]);
    expectResizeBeforeCapture(recorder.ops, '100x30');
    cleanupSelectSessions(large);
  });

  test('follower sized select does not resize to follower size; history is captured at owner size', () => {
    const { server, recorder, large, small, entry } = setupTwoClients({
      paneCount: 2,
      session: true,
    });
    termResize(server, large, '%0', 160, 48);
    termResize(server, small, '%0', 80, 24);
    const live = entry.lastSnapshot?.session?.windows[0]?.panes[0];
    if (live) {
      live.width = 80;
      live.height = 24;
    }
    recorder.ops.length = 0;
    recorder.resizeWindowCalls.length = 0;
    recorder.resizePaneCalls.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;
    recorder.selectPaneCalls.length = 0;

    server.handleTmuxSelect(large, {
      ...sizedSelect('%1', 160, 48, 10),
      windowId: '@1',
    });

    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.resizeWindowCalls).toEqual([]);
    expect(recorder.selectPaneWithSizeCalls).toEqual([]);
    expect(recorder.selectPaneCalls).toEqual([{ windowId: '@1', paneId: '%1' }]);
    expect(recorder.ops).toEqual(['selectPane:@1:%1', 'capture']);

    const drifted = entry.lastSnapshot?.session?.windows[0];
    expect(drifted).toBeDefined();
    if (!drifted) return;
    drifted.layout = '0000,40x12,0,0,0';
    recorder.ops.length = 0;
    recorder.selectPaneCalls.length = 0;
    recorder.selectPaneWithSizeCalls.length = 0;

    server.handleTmuxSelect(large, {
      ...sizedSelect('%1', 160, 48, 11),
      windowId: '@1',
    });

    expect(recorder.selectPaneWithSizeCalls).toEqual([
      { windowId: '@1', paneId: '%1', cols: 80, rows: 24 },
    ]);
    expect(recorder.ops.some((op) => op.includes('160x48'))).toBe(false);
    expectResizeBeforeCapture(recorder.ops, '80x24');
    cleanupSelectSessions(large, small);
  });

  test('snapshot install re-keys a moved pane claim and arbitrates the destination window', () => {
    const { server, recorder, large, entry } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    expect(large.viewportClaims.has('device-a/@1')).toBe(true);
    recorder.resizePaneCalls.length = 0;
    recorder.resizeWindowCalls.length = 0;
    large.sent.length = 0;

    server.installStateSnapshot(
      'device-a',
      snapshot([
        {
          id: '@2',
          name: 'w2',
          index: 0,
          active: true,
          panes: [pane('%0', '@2', 0, 80, 24)],
        },
      ])
    );

    expect(large.viewportClaims.has('device-a/@1')).toBe(false);
    expect(large.viewportClaims.get('device-a/@2')).toMatchObject({
      paneId: '%0',
      cols: 160,
      rows: 48,
      visible: true,
    });
    expect(entry.lastAppliedViewport?.has('@1')).toBe(false);
    expect(entry.lastViewportWinnerId?.has('@1')).toBe(false);
    expect(recorder.resizePaneCalls).toEqual([['%0', 160, 48]]);
    expect(lastPolicy(large)).toMatchObject({
      deviceId: 'device-a',
      windowId: '@2',
      paneId: '%0',
      owner: true,
      cols: 160,
      rows: 48,
    });
  });

  test('snapshot install drops claims for a closed window and prunes applied state', () => {
    const { server, recorder, large, entry } = setupTwoClients();
    termResize(server, large, '%0', 160, 48);
    recorder.resizePaneCalls.length = 0;
    recorder.resizeWindowCalls.length = 0;

    server.installStateSnapshot(
      'device-a',
      snapshot([
        {
          id: '@9',
          name: 'other',
          index: 0,
          active: true,
          panes: [pane('%8', '@9', 0, 80, 24)],
        },
      ])
    );

    expect(large.viewportClaims.size).toBe(0);
    expect(entry.lastAppliedViewport?.has('@1')).toBe(false);
    expect(entry.lastViewportWinnerId?.has('@1')).toBe(false);
    expect(recorder.resizePaneCalls).toEqual([]);
    expect(recorder.resizeWindowCalls).toEqual([]);
  });
});
