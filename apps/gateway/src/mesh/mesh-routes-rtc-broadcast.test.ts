import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { NodeSessionStore } from '../auth/node-session-store';
import type { UserStore } from '../auth/user-store';
import { MESH_WS_KIND, type MeshServerWebSocket, type RtcSignalMessage } from './mesh-deps';
import { MeshRoutes, type MeshRoutesDeps } from './mesh-routes';
import { RTC_BROWSER_REPLAY_TTL_MS } from './rtc/browser-signal-replay';
import { MeshRtcSignalRouter } from './rtc/signaling';

function socket(sid: string, frames: Uint8Array[]): MeshServerWebSocket {
  return {
    data: { kind: MESH_WS_KIND, sid, uid: 'user-1' },
    send(data: Uint8Array | ArrayBuffer | ArrayBufferView | string) {
      if (data instanceof Uint8Array) frames.push(data);
      return 1;
    },
    close() {},
  };
}

function sdpOf(frame: Uint8Array): string | null {
  const env = wsBorsh.decodeEnvelope(frame);
  const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
  return payload.sdp;
}

function candidateOf(frame: Uint8Array): string | null {
  const env = wsBorsh.decodeEnvelope(frame);
  const payload = wsBorsh.decodePayload(wsBorsh.schema.RtcSignalSchema, env.payload);
  return payload.candidate;
}

describe('node→browser RTC broadcast', () => {
  test('only the owning session receives signals, and a reconnect replays the short buffer', () => {
    let now = 10_000;
    const router = new MeshRtcSignalRouter({
      selfNodeId: 'aa',
      sendCtl: () => {
        throw new Error('remote forward is not this test');
      },
      now: () => now,
    });
    const routes = new MeshRoutes({
      roles: { node: true, relay: false },
      nodeId: 'aa',
      nodePk: new Uint8Array(32),
      userStore: {} as UserStore,
      nodeSessionStore: {} as NodeSessionStore,
      peers: { onNodeEvent: () => () => {} },
      rtcSignals: router,
      now: () => now,
    } as unknown as MeshRoutesDeps);
    router.register('sess-1', { browserSessionId: 'sid-a', targetNodeId: 'bb' });
    const owner: Uint8Array[] = [];
    const other: Uint8Array[] = [];
    const ownerWs = socket('sid-a', owner);
    routes.handleMeshSocketOpen(ownerWs);
    routes.handleMeshSocketOpen(socket('sid-b', other));
    const answer: RtcSignalMessage = {
      rtcSession: 'sess-1',
      from: 'node',
      to: 'bb',
      sdp: 'answer',
    };
    router.receiveFromNode('bb', answer);
    expect(owner.map(sdpOf)).toEqual(['answer']);
    expect(other).toEqual([]);

    routes.handleMeshSocketClose(ownerWs);
    router.receiveFromNode('bb', {
      rtcSession: 'sess-1',
      from: 'node',
      to: 'bb',
      candidate: 'c1',
    });
    expect(owner.map(candidateOf).filter(Boolean)).toEqual([]);

    const replayed: Uint8Array[] = [];
    routes.handleMeshSocketOpen(socket('sid-a', replayed));
    expect(replayed.map((frame) => sdpOf(frame) ?? candidateOf(frame))).toEqual(['answer', 'c1']);
    const stranger: Uint8Array[] = [];
    routes.handleMeshSocketOpen(socket('sid-b', stranger));
    expect(stranger).toEqual([]);

    now += RTC_BROWSER_REPLAY_TTL_MS;
    const late: Uint8Array[] = [];
    routes.handleMeshSocketOpen(socket('sid-a', late));
    expect(late).toEqual([]);
    routes.stop();
  });
});
