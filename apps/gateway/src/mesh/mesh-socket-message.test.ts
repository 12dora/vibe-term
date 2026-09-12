import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@vibeterm/shared';
import type { MeshServerWebSocket } from './mesh-deps';
import { dispatchMeshSocketMessage } from './mesh-socket-message';

const wsOf = (data: { uid?: string; sid?: string } = {}) =>
  ({ data }) as unknown as MeshServerWebSocket;

describe('dispatchMeshSocketMessage', () => {
  test('PING is answered with a PONG carrying the same payload even without rtc signalling', () => {
    const sent: Uint8Array[] = [];
    const payload = new Uint8Array([1, 2, 3]);
    dispatchMeshSocketMessage(
      { rtcSignals: null, send: (_ws, frame) => sent.push(frame), nextSeq: () => 7 },
      wsOf(),
      wsBorsh.encodeEnvelope(wsBorsh.KIND_PING, payload, 1)
    );
    expect(sent).toHaveLength(1);
    const env = wsBorsh.decodeEnvelope(sent[0] as Uint8Array);
    expect(env.kind).toBe(wsBorsh.KIND_PONG);
    expect(env.seq).toBe(7);
    expect(Array.from(env.payload)).toEqual([1, 2, 3]);
  });

  test('browser RTC signal is forwarded with the session identity; node-origin signals are dropped', () => {
    const forwarded: unknown[] = [];
    const rtcSignals = {
      send: (signal: unknown, who: unknown) => forwarded.push([signal, who]),
      subscribe: () => () => {},
    };
    const encode = (from: number) =>
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_RTC_SIGNAL,
        wsBorsh.encodePayload(wsBorsh.schema.RtcSignalSchema, {
          rtcSession: 'rs1',
          from,
          to: 'n2',
          sdp: 'offer',
          candidate: null,
        }),
        1
      );
    const deps = { rtcSignals: rtcSignals as never, send: () => {}, nextSeq: () => 1 };
    dispatchMeshSocketMessage(
      deps,
      wsOf({ uid: 'u', sid: 's' }),
      encode(wsBorsh.RTC_SIGNAL_FROM_NODE)
    );
    expect(forwarded).toHaveLength(0);
    dispatchMeshSocketMessage(
      deps,
      wsOf({ uid: 'u', sid: 's' }),
      encode(wsBorsh.RTC_SIGNAL_FROM_BROWSER)
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toEqual([
      { rtcSession: 'rs1', from: 'browser', to: 'n2', sdp: 'offer', candidate: null },
      { uid: 'u', sid: 's' },
    ]);
  });
});
