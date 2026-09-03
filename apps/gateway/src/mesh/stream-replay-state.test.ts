import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { type InboundReplayNote, StreamReplayState } from './stream-replay-state';

function encodeDeviceConnect(deviceId: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectSchema, { deviceId }),
    1
  );
}

function encodeDeviceConnected(deviceId: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_CONNECTED,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, { deviceId }),
    2
  );
}

function encodeDeviceDisconnect(deviceId: string): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_DEVICE_DISCONNECT,
    wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectSchema, { deviceId }),
    6
  );
}

function encodeHelloC2S(maxFrameBytes: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_HELLO_C2S,
    wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
      clientImpl: 'stream-replay-test',
      clientVersion: '1.1.23',
      maxFrameBytes,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    }),
    1
  );
}

function encodeHelloS2C(maxFrameBytes: number, serverVersion = '1.1.23'): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_HELLO_S2C,
    wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
      serverImpl: 'tmex-gateway',
      serverVersion,
      selectedVersion: wsBorsh.CURRENT_VERSION,
      maxFrameBytes,
      heartbeatIntervalMs: 15_000,
      capabilities: ['canonical-state-v1', 'canonical-state-v1.1'],
    }),
    1
  );
}

function encodeCanonicalSubscription(
  generation: bigint,
  activePanes: wsBorsh.CanonicalPaneSubscription[],
  hotPanes: wsBorsh.CanonicalPaneSubscription[] = []
): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_COMMAND,
    wsBorsh.encodeCanonicalCommandPayload({
      SetPaneSubscriptions: { generation, activePanes, hotPanes },
    }),
    4
  );
}

function encodeCanonicalEvent(event: wsBorsh.CanonicalEvent, seq = 5): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_EVENT,
    wsBorsh.encodeCanonicalEventPayload(event),
    seq
  );
}

function encodeCanonicalCommand(command: wsBorsh.CanonicalCommand, seq = 7): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_CANONICAL_COMMAND,
    wsBorsh.encodeCanonicalCommandPayload(command),
    seq
  );
}

function decodeCanonicalSubscription(frames: Uint8Array[]) {
  const frame = frames.find(
    (candidate) => wsBorsh.decodeEnvelope(candidate).kind === wsBorsh.KIND_CANONICAL_COMMAND
  );
  if (!frame) throw new Error('missing canonical subscription');
  const command = wsBorsh.decodeCanonicalCommandPayload(
    wsBorsh.decodeEnvelope(frame).payload
  ).command;
  if (!('SetPaneSubscriptions' in command)) throw new Error('expected canonical subscription');
  return command.SetPaneSubscriptions;
}

describe('StreamReplayState.noteInbound', () => {
  test('DEVICE_CONNECTED 一次解码即返回 kind 与 deviceId，并记入 resume', () => {
    const replay = new StreamReplayState();
    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    expect(replay.isResumeReady()).toBe(false);
    const noted = replay.noteInbound(encodeDeviceConnected('dev-1'));
    expect(noted).toEqual({ kind: wsBorsh.KIND_DEVICE_CONNECTED, deviceId: 'dev-1' });
    expect(replay.isResumeReady()).toBe(true);
    expect('noteDeviceConnected' in replay).toBe(false);
  });

  test('DEVICE_CONNECTED payload 损坏时仍返回 kind、不带 deviceId、不推进 resume', () => {
    const replay = new StreamReplayState();
    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    const malformed = wsBorsh.encodeEnvelope(
      wsBorsh.KIND_DEVICE_CONNECTED,
      new Uint8Array([0xff, 0x00]),
      2
    );
    const noted = replay.noteInbound(malformed);
    expect(noted).toEqual({ kind: wsBorsh.KIND_DEVICE_CONNECTED });
    expect(noted.deviceId).toBeUndefined();
    expect(replay.isResumeReady()).toBe(false);
  });

  test('无法解码的 envelope 返回 kind: null', () => {
    const replay = new StreamReplayState();
    expect(replay.noteInbound(new Uint8Array([1, 2, 3]))).toEqual({ kind: null });
  });
});

describe('StreamReplayState.rewriteQueuedFrame', () => {
  test('无法解码的帧原样返回', () => {
    const replay = new StreamReplayState();
    const original = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const returned = replay.rewriteQueuedFrame(original);
    expect(returned).toBe(original);
  });
});

describe('StreamReplayState canonical v1.1 对端门槛', () => {
  test('HELLO_S2C 未到达时 fail-closed', () => {
    const replay = new StreamReplayState();
    expect(replay.peerVersion).toBeNull();
    expect(replay.peerSupportsCanonical()).toBe(false);
  });

  test('对端版本 >= 1.1.22 才放行', () => {
    const supported = new StreamReplayState();
    expect(supported.noteInbound(encodeHelloS2C(65_536, '1.1.23'))).toEqual({
      kind: wsBorsh.KIND_HELLO_S2C,
      peerUnsupported: false,
    });
    expect(supported.peerVersion).toBe('1.1.23');
    expect(supported.peerSupportsCanonical()).toBe(true);

    const stale = new StreamReplayState();
    expect(stale.noteInbound(encodeHelloS2C(65_536, '1.1.21'))).toEqual({
      kind: wsBorsh.KIND_HELLO_S2C,
      peerUnsupported: true,
    });
    expect(stale.peerVersion).toBe('1.1.21');
    expect(stale.peerSupportsCanonical()).toBe(false);
  });
});

describe('StreamReplayState canonical failover replay', () => {
  test('uses generation+1 and the latest PaneData cursor', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };

    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    replay.noteOutbound(encodeDeviceConnect('dev-2'));
    replay.noteOutbound(
      encodeCanonicalSubscription(7n, [{ pane, cursor: { paneEpoch, terminalSeq: 0n } }])
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        PaneData: {
          pane,
          paneEpoch,
          seqStart: 0n,
          seqEnd: 4n,
          data: new Uint8Array([1, 2, 3, 4]),
        },
      })
    );
    replay.beginResume();
    expect(replay.isResumeReady()).toBe(false);
    const connectFrames = replay.buildConnectFrames();
    expect(connectFrames.map((frame) => wsBorsh.decodeEnvelope(frame).kind)).toEqual([
      wsBorsh.KIND_CANONICAL_COMMAND,
      wsBorsh.KIND_DEVICE_CONNECT,
      wsBorsh.KIND_DEVICE_CONNECT,
    ]);
    const bootstrap = decodeCanonicalSubscription(connectFrames);
    expect(bootstrap).toEqual({ generation: 0n, activePanes: [], hotPanes: [] });
    replay.noteInbound(encodeDeviceConnected('dev-1'));
    expect(replay.isResumeReady()).toBe(false);
    replay.noteInbound(encodeDeviceConnected('dev-2'));
    expect(replay.isResumeReady()).toBe(true);

    const frames = replay.buildPostConnectFrames();
    expect(frames.map((frame) => wsBorsh.decodeEnvelope(frame).kind)).toEqual([
      wsBorsh.KIND_CANONICAL_COMMAND,
    ]);
    const subscription = decodeCanonicalSubscription(frames);
    expect(subscription.generation).toBe(8n);
    expect(subscription.activePanes[0]?.cursor).toEqual({ paneEpoch, terminalSeq: 4n });
  });

  test('DEVICE_DISCONNECT removes canonical panes and cursor state', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const first = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    const second = { deviceId: 'dev-2', serverEpoch, paneId: '%2' };
    replay.noteOutbound(
      encodeCanonicalSubscription(
        1n,
        [{ pane: first, cursor: { paneEpoch, terminalSeq: 1n } }],
        [{ pane: second, cursor: { paneEpoch, terminalSeq: 2n } }]
      )
    );
    expect(replay.paneCursors.size).toBe(2);

    replay.noteOutbound(encodeDeviceDisconnect('dev-1'));

    const subscription = decodeCanonicalSubscription(replay.buildPostConnectFrames());
    expect(subscription.generation).toBe(2n);
    expect(subscription.activePanes).toEqual([]);
    expect(subscription.hotPanes.map((row) => row.pane.deviceId)).toEqual(['dev-2']);
    expect(Array.from(replay.paneCursors.values(), (cursor) => cursor.pane.deviceId)).toEqual([
      'dev-2',
    ]);
  });

  test('advances a cursor only after a complete Screen transaction commits', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    replay.noteOutbound(
      encodeCanonicalSubscription(1n, [{ pane, cursor: { paneEpoch, terminalSeq: 5n } }])
    );

    const incompleteId = new Uint8Array(16).fill(3);
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenBegin: {
          requestId: incompleteId,
          pane,
          paneEpoch,
          baseSeq: 20n,
          rows: 24,
          cols: 80,
          modes: 0,
          totalBytes: 4,
        },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenChunk: { requestId: incompleteId, offset: 0, data: new Uint8Array([1, 2]) },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenCommit: { requestId: incompleteId, totalBytes: 4, historyCursor: null },
      })
    );
    expect(
      decodeCanonicalSubscription(replay.buildPostConnectFrames()).activePanes[0]?.cursor
        ?.terminalSeq
    ).toBe(5n);

    const completeId = new Uint8Array(16).fill(4);
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenBegin: {
          requestId: completeId,
          pane,
          paneEpoch,
          baseSeq: 20n,
          rows: 24,
          cols: 80,
          modes: 0,
          totalBytes: 4,
        },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenChunk: { requestId: completeId, offset: 0, data: new Uint8Array([1, 2]) },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenChunk: { requestId: completeId, offset: 2, data: new Uint8Array([3, 4]) },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        ScreenCommit: { requestId: completeId, totalBytes: 4, historyCursor: null },
      })
    );

    expect(
      decodeCanonicalSubscription(replay.buildPostConnectFrames()).activePanes[0]?.cursor
    ).toEqual({ paneEpoch, terminalSeq: 20n });
  });

  test('does not inject a cursor from a different server or pane epoch', () => {
    const replay = new StreamReplayState();
    const oldServerEpoch = new Uint8Array(16).fill(1);
    const newServerEpoch = new Uint8Array(16).fill(2);
    const oldPaneEpoch = new Uint8Array(16).fill(3);
    const newPaneEpoch = new Uint8Array(16).fill(4);
    const oldPane = { deviceId: 'dev-1', serverEpoch: oldServerEpoch, paneId: '%1' };
    const newPane = { deviceId: 'dev-1', serverEpoch: newServerEpoch, paneId: '%1' };
    replay.noteOutbound(
      encodeCanonicalSubscription(1n, [
        { pane: oldPane, cursor: { paneEpoch: oldPaneEpoch, terminalSeq: 1n } },
      ])
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        PaneData: {
          pane: oldPane,
          paneEpoch: oldPaneEpoch,
          seqStart: 1n,
          seqEnd: 3n,
          data: new Uint8Array([1, 2]),
        },
      })
    );
    replay.noteOutbound(
      encodeCanonicalSubscription(2n, [
        { pane: newPane, cursor: { paneEpoch: newPaneEpoch, terminalSeq: 0n } },
      ])
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        PaneData: {
          pane: oldPane,
          paneEpoch: oldPaneEpoch,
          seqStart: 3n,
          seqEnd: 5n,
          data: new Uint8Array([3, 4]),
        },
      })
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        PaneData: {
          pane: newPane,
          paneEpoch: oldPaneEpoch,
          seqStart: 5n,
          seqEnd: 7n,
          data: new Uint8Array([5, 6]),
        },
      })
    );

    expect(
      decodeCanonicalSubscription(replay.buildPostConnectFrames()).activePanes[0]?.cursor
    ).toEqual({ paneEpoch: newPaneEpoch, terminalSeq: 0n });
  });

  test('Pane SourceGap clears the resume cursor', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    replay.noteOutbound(
      encodeCanonicalSubscription(1n, [{ pane, cursor: { paneEpoch, terminalSeq: 5n } }])
    );
    replay.noteInbound(
      encodeCanonicalEvent({
        SourceGap: {
          reason: wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED,
          scope: {
            Pane: {
              pane,
              expectedPaneEpoch: paneEpoch,
              availablePaneEpoch: paneEpoch,
              expectedSeq: 5n,
              availableSeq: 9n,
            },
          },
        },
      })
    );

    expect(
      decodeCanonicalSubscription(replay.buildPostConnectFrames()).activePanes[0]?.cursor
    ).toBeNull();
    expect(replay.paneCursors.size).toBe(0);
  });

  test('drops cursors and signals a stream gap when resume cursors exceed the effective frame limit', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    const withoutCursorBytes = encodeCanonicalSubscription(2n, [{ pane, cursor: null }]).byteLength;
    const withCursorBytes = encodeCanonicalSubscription(2n, [
      { pane, cursor: { paneEpoch, terminalSeq: 9n } },
    ]).byteLength;
    expect(withCursorBytes).toBeGreaterThan(withoutCursorBytes);

    replay.noteOutbound(encodeHelloC2S(withCursorBytes));
    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    replay.noteOutbound(
      encodeCanonicalSubscription(1n, [{ pane, cursor: { paneEpoch, terminalSeq: 9n } }])
    );
    replay.beginResume();
    replay.noteInbound(encodeHelloS2C(withoutCursorBytes));

    const connectFrames = replay.buildConnectFrames();
    const postConnectFrames = replay.buildPostConnectFrames();
    const signals = replay.browserSignalFrames();
    const canonicalFrames = [...connectFrames, ...postConnectFrames, ...signals].filter((frame) => {
      const kind = wsBorsh.decodeEnvelope(frame).kind;
      return kind === wsBorsh.KIND_CANONICAL_COMMAND || kind === wsBorsh.KIND_CANONICAL_EVENT;
    });
    expect(canonicalFrames.every((frame) => frame.byteLength <= withoutCursorBytes)).toBe(true);
    expect(decodeCanonicalSubscription(postConnectFrames).activePanes[0]?.cursor).toBeNull();
    expect(signals).toHaveLength(1);
    const gap = wsBorsh.decodeCanonicalEventPayload(
      wsBorsh.decodeEnvelope(signals[0] as Uint8Array).payload
    ).event;
    expect('SourceGap' in gap && gap.SourceGap.reason).toBe(
      wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED
    );
    expect('SourceGap' in gap && 'Stream' in gap.SourceGap.scope).toBe(true);

    replay.beginResume();
    expect(replay.browserSignalFrames()).toEqual([]);
  });

  test('omits canonical recovery frames when even a cursorless subscription cannot fit', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    const gapFrameBytes = encodeCanonicalEvent({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
        scope: { Stream: {} },
      },
    }).byteLength;
    const bootstrapBytes = encodeCanonicalSubscription(0n, []).byteLength;
    expect(gapFrameBytes).toBeLessThan(bootstrapBytes);

    replay.noteOutbound(encodeHelloC2S(gapFrameBytes));
    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    replay.noteOutbound(
      encodeCanonicalSubscription(1n, [{ pane, cursor: { paneEpoch, terminalSeq: 9n } }])
    );
    replay.beginResume();
    replay.noteInbound(encodeHelloS2C(gapFrameBytes));

    expect(replay.buildConnectFrames()).toEqual([]);
    expect(replay.buildPostConnectFrames()).toEqual([]);
    const signals = replay.browserSignalFrames();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.byteLength).toBeLessThanOrEqual(gapFrameBytes);
  });

  test('rewrites an oversized queued subscription without cursors and advances generation', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    const cursorlessBytes = encodeCanonicalSubscription(6n, [{ pane, cursor: null }]).byteLength;
    const queued = encodeCanonicalSubscription(4n, [
      { pane, cursor: { paneEpoch, terminalSeq: 9n } },
    ]);
    expect(queued.byteLength).toBeGreaterThan(cursorlessBytes);

    replay.noteOutbound(encodeHelloC2S(queued.byteLength));
    replay.noteOutbound(
      encodeCanonicalSubscription(3n, [{ pane, cursor: { paneEpoch, terminalSeq: 8n } }])
    );
    replay.beginResume();
    replay.noteInbound(encodeHelloS2C(cursorlessBytes));
    replay.noteOutbound(queued);
    replay.markCanonicalResumeSent();

    const rewritten = replay.rewriteQueuedFrame(queued);
    expect(rewritten).not.toBeNull();
    expect((rewritten as Uint8Array).byteLength).toBeLessThanOrEqual(cursorlessBytes);
    const subscription = decodeCanonicalSubscription([rewritten as Uint8Array]);
    expect(subscription.generation).toBe(6n);
    expect(subscription.activePanes[0]?.cursor).toBeNull();
    const signals = replay.browserSignalFrames();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.byteLength).toBeLessThanOrEqual(cursorlessBytes);
  });

  test('drops a queued subscription when its cursorless form still exceeds the new limit', () => {
    const replay = new StreamReplayState();
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = {
      deviceId: 'dev-1',
      serverEpoch: new Uint8Array(16).fill(1),
      paneId: '%1',
    };
    const queued = encodeCanonicalSubscription(2n, [
      { pane, cursor: { paneEpoch, terminalSeq: 9n } },
    ]);
    const gapFrameBytes = encodeCanonicalEvent({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
        scope: { Stream: {} },
      },
    }).byteLength;
    replay.noteOutbound(encodeHelloC2S(queued.byteLength));
    replay.noteOutbound(encodeCanonicalSubscription(1n, [{ pane, cursor: null }]));
    replay.beginResume();
    replay.noteInbound(encodeHelloS2C(gapFrameBytes));
    replay.markCanonicalResumeSent();

    expect(replay.rewriteQueuedFrame(queued)).toBeNull();
    const signals = replay.browserSignalFrames();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.byteLength).toBeLessThanOrEqual(gapFrameBytes);
  });

  test('drops oversized queued non-subscription canonical commands and keeps fitting ones', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };
    const fitting = encodeCanonicalCommand({
      ResizePane: { requestId: new Uint8Array(16).fill(3), pane, rows: 24, cols: 80 },
    });
    const oversized = encodeCanonicalCommand({
      TerminalInput: {
        requestId: new Uint8Array(16).fill(4),
        pane,
        paneEpoch,
        inputId: new Uint8Array(16).fill(5),
        data: new Uint8Array(256).fill(6),
      },
    });
    expect(oversized.byteLength).toBeGreaterThan(fitting.byteLength);
    replay.noteOutbound(encodeHelloC2S(oversized.byteLength));
    replay.beginResume();
    replay.noteInbound(encodeHelloS2C(fitting.byteLength));

    expect(replay.rewriteQueuedFrame(fitting)).toBe(fitting);
    expect(replay.rewriteQueuedFrame(oversized)).toBeNull();
    const signals = replay.browserSignalFrames();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.byteLength).toBeLessThanOrEqual(fitting.byteLength);
  });

  test('drops queued generic CHUNK frames that carry a canonical command', () => {
    const replay = new StreamReplayState();
    const pane = {
      deviceId: 'dev-1',
      serverEpoch: new Uint8Array(16).fill(1),
      paneId: '%1',
    };
    const payload = wsBorsh.encodeCanonicalCommandPayload({
      RequestScreen: { requestId: new Uint8Array(16).fill(2), pane, byteLimit: 1024 },
    });
    const split = wsBorsh.splitPayloadIntoChunks(payload, wsBorsh.KIND_CANONICAL_COMMAND, 7, {
      maxFrameBytes: 64,
      chunkStreamId: wsBorsh.generateChunkStreamId(),
    });
    expect(split.chunks.length).toBeGreaterThan(0);
    const first = split.chunks[0];
    if (!first) throw new Error('missing canonical chunk');
    const chunk = wsBorsh.encodeChunk(first, 8);

    replay.beginResume();
    expect(replay.rewriteQueuedFrame(chunk)).toBeNull();
    expect(replay.browserSignalFrames()).toHaveLength(1);
  });
});

/** 与 replay 状态无关的大帧：仅用来验证信封解码路径与性能。 */
function encodeLargeFrame(data: Uint8Array, seq = 9): Uint8Array {
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_TERM_PASTE, data, seq);
}

function replayDecisionSnapshot(replay: StreamReplayState) {
  return {
    devices: [...replay.devices.keys()].sort(),
    agents: [...replay.agents.keys()].sort(),
    canonicalGeneration: replay.canonicalSub?.generation ?? null,
    canonicalActive: replay.canonicalSub?.activePanes.map((row) => row.pane.paneId) ?? [],
    describe: replay.describeReplay(),
    resumeReady: replay.isResumeReady(),
    helloBytes: replay.hello?.byteLength ?? 0,
    clientMaxFromHello: replay.hello
      ? wsBorsh.decodePayload(
          wsBorsh.schema.HelloC2SSchema,
          wsBorsh.decodeEnvelopeView(replay.hello).payload
        ).maxFrameBytes
      : null,
  };
}

describe('StreamReplayState decodeEnvelopeView', () => {
  test('recorded frame sequence yields identical replay decisions', () => {
    const replay = new StreamReplayState();
    const epoch = new Uint8Array(16).fill(3);
    const pane = { deviceId: 'dev-1', serverEpoch: epoch, paneId: '%1' };
    const inboundNotes: InboundReplayNote[] = [];

    replay.noteOutbound(encodeHelloC2S(65_536));
    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    replay.noteOutbound(
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_AGENT_SUBSCRIBE,
        wsBorsh.encodePayload(wsBorsh.schema.AgentSubscribeSchema, { sessionId: 'ag-1' }),
        5
      )
    );
    replay.noteOutbound(
      encodeCanonicalSubscription(2n, [{ pane, cursor: { paneEpoch: epoch, terminalSeq: 0n } }])
    );
    replay.noteOutbound(encodeLargeFrame(new Uint8Array(32 * 1024).fill(0x41), 10));

    inboundNotes.push(replay.noteInbound(encodeHelloS2C(65_536)));
    inboundNotes.push(replay.noteInbound(encodeDeviceConnected('dev-1')));
    inboundNotes.push(
      replay.noteInbound(
        encodeCanonicalEvent({
          PaneData: {
            pane,
            paneEpoch: epoch,
            seqStart: 0n,
            seqEnd: 4n,
            data: new Uint8Array([1, 2, 3, 4]),
          },
        })
      )
    );
    inboundNotes.push(replay.noteInbound(new Uint8Array([1, 2, 3])));

    expect(inboundNotes).toEqual([
      { kind: wsBorsh.KIND_HELLO_S2C, peerUnsupported: false },
      { kind: wsBorsh.KIND_DEVICE_CONNECTED, deviceId: 'dev-1' },
      { kind: wsBorsh.KIND_CANONICAL_EVENT },
      { kind: null },
    ]);
    expect(replayDecisionSnapshot(replay)).toEqual({
      devices: ['dev-1'],
      agents: ['ag-1'],
      canonicalGeneration: 2n,
      canonicalActive: ['%1'],
      describe: { mode: 'canonical', panes: '%1', cursor: '%1:4' },
      resumeReady: true,
      helloBytes: encodeHelloC2S(65_536).byteLength,
      clientMaxFromHello: 65_536,
    });

    replay.noteOutbound(encodeDeviceDisconnect('dev-1'));
    replay.noteOutbound(
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_AGENT_UNSUBSCRIBE,
        wsBorsh.encodePayload(wsBorsh.schema.AgentUnsubscribeSchema, { sessionId: 'ag-1' }),
        12
      )
    );
    expect(replay.devices.size).toBe(0);
    expect(replay.agents.size).toBe(0);
    expect(replay.describeReplay()).toEqual({ mode: 'canonical', panes: '-', cursor: '-' });
  });

  test('stored outbound copies survive mutation of the original buffer', () => {
    const replay = new StreamReplayState();
    const hello = encodeHelloC2S(32_768);
    const connect = encodeDeviceConnect('dev-keep');
    replay.noteOutbound(hello);
    replay.noteOutbound(connect);
    hello.fill(0);
    connect.fill(0);
    expect(replay.hello).not.toBeNull();
    expect(wsBorsh.decodeEnvelopeView(replay.hello as Uint8Array).kind).toBe(
      wsBorsh.KIND_HELLO_C2S
    );
    expect(
      wsBorsh.decodePayload(
        wsBorsh.schema.DeviceConnectSchema,
        wsBorsh.decodeEnvelopeView([...replay.devices.values()][0] as Uint8Array).payload
      ).deviceId
    ).toBe('dev-keep');
  });

  test('decodeEnvelopeView is at least 10× faster than decodeEnvelope on a 32 KiB frame', () => {
    const frame = encodeLargeFrame(new Uint8Array(32 * 1024).fill(0x42), 1);
    const iterations = 400;
    for (let i = 0; i < 40; i += 1) {
      wsBorsh.decodeEnvelope(frame);
      wsBorsh.decodeEnvelopeView(frame);
    }
    const copyStart = performance.now();
    for (let i = 0; i < iterations; i += 1) wsBorsh.decodeEnvelope(frame);
    const copyMs = performance.now() - copyStart;
    const viewStart = performance.now();
    for (let i = 0; i < iterations; i += 1) wsBorsh.decodeEnvelopeView(frame);
    const viewMs = performance.now() - viewStart;
    expect(wsBorsh.decodeEnvelopeView(frame).kind).toBe(wsBorsh.decodeEnvelope(frame).kind);
    expect(wsBorsh.decodeEnvelopeView(frame).seq).toBe(wsBorsh.decodeEnvelope(frame).seq);
    expect(viewMs * 10).toBeLessThan(copyMs);
  });
});
