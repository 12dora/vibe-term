import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { WebSocketServer } from './index';
import { createGatewaySession, setupConnectionEntry } from './test-helpers';

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
    runtime: {
      resizeWindow(windowId: string, cols: number, rows: number) {
        recorder.resizeWindowCalls.push([windowId, cols, rows]);
      },
      resizePane(paneId: string, cols: number, rows: number) {
        recorder.resizePaneCalls.push([paneId, cols, rows]);
      },
      requestSnapshot() {},
    },
  };
  return recorder;
}

function setupTwoClients() {
  const server = new WebSocketServer();
  const recorder = createResizeRecorder();
  const large = createGatewaySession({ id: 'sess-large' });
  const small = createGatewaySession({ id: 'sess-small' });
  const entry = setupConnectionEntry(server, {
    deviceId: 'device-a',
    runtime: recorder.runtime,
    clients: new Set([large, small]),
    lastSnapshot: {
      deviceId: 'device-a',
      session: {
        id: '$1',
        name: 'tmex',
        windows: [
          {
            id: '@1',
            name: 'w1',
            index: 0,
            active: true,
            panes: [
              {
                id: '%0',
                windowId: '@1',
                index: 0,
                title: 't',
                active: true,
                width: 80,
                height: 24,
              },
            ],
          },
        ],
      },
    },
  });
  return { server, recorder, large, small, entry };
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
});
