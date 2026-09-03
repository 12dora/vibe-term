import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { StreamReplayState } from './stream-replay-state';

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
      clientVersion: 'test',
      maxFrameBytes,
      supportsCompression: false,
      supportsDiffSnapshot: false,
    }),
    1
  );
}

function encodeHelloS2C(maxFrameBytes: number): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_HELLO_S2C,
    wsBorsh.encodePayload(wsBorsh.schema.HelloS2CSchema, {
      serverImpl: 'tmex-gateway',
      serverVersion: 'test',
      selectedVersion: wsBorsh.CURRENT_VERSION,
      maxFrameBytes,
      heartbeatIntervalMs: 15_000,
      capabilities: ['canonical-state-v1'],
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

function encodeSubscribe(deviceId: string, paneIds: string[]): Uint8Array {
  return wsBorsh.encodeEnvelope(
    wsBorsh.KIND_TMUX_SUBSCRIBE_PANES,
    wsBorsh.encodePayload(wsBorsh.schema.TmuxSubscribePanesSchema, { deviceId, paneIds }),
    3
  );
}

function decodeHistoryRequests(frames: Uint8Array[]): Array<{ paneId: string; byteLimit: number }> {
  const out: Array<{ paneId: string; byteLimit: number }> = [];
  for (const frame of frames) {
    try {
      const env = wsBorsh.decodeEnvelope(frame);
      if (env.kind !== wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY) continue;
      const payload = wsBorsh.schema.decodeTmuxFetchPaneHistory(env.payload);
      out.push({ paneId: payload.paneId, byteLimit: payload.byteLimit ?? 0 });
    } catch {
      // ignore
    }
  }
  return out;
}

function decodeSourceGapPanes(frames: Uint8Array[]): string[] {
  const out: string[] = [];
  for (const frame of frames) {
    try {
      const env = wsBorsh.decodeEnvelope(frame);
      if (env.kind !== wsBorsh.KIND_CANONICAL_EVENT) continue;
      const event = wsBorsh.decodeCanonicalEventPayload(env.payload).event;
      if (!('SourceGap' in event) || !('Pane' in event.SourceGap.scope)) continue;
      expect(event.SourceGap.reason).toBe(wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED);
      out.push(event.SourceGap.scope.Pane.pane.paneId);
    } catch {
      // ignore
    }
  }
  return out;
}

describe('StreamReplayState legacy failover history cap', () => {
  test('divides the remaining budget so every pane gets a bounded tail with byteLimit', () => {
    const prevPane = process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE;
    process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE = String(256 * 1024);
    try {
      const replay = new StreamReplayState();
      replay.noteOutbound(encodeSubscribe('dev-1', ['%1', '%2', '%3', '%4', '%5']));
      const frames = replay.buildPostConnectFrames();
      const history = decodeHistoryRequests(frames);
      expect(history).toHaveLength(5);
      expect(history.every((row) => row.byteLimit > 0 && row.byteLimit <= 256 * 1024)).toBe(true);
      expect(history.reduce((sum, row) => sum + row.byteLimit, 0)).toBeLessThanOrEqual(1024 * 1024);
      expect(history.map((row) => row.paneId)).toEqual(['%1', '%2', '%3', '%4', '%5']);
      const stats = replay.legacyReplayStats();
      expect(stats.historyPanes).toBe(5);
      expect(stats.skippedPanes).toEqual([]);
      expect(stats.gapPanes).toEqual([]);
      expect(stats.replayBytes).toBe(history.reduce((sum, row) => sum + row.byteLimit, 0));
      expect(replay.browserSignalFrames()).toEqual([]);
      expect(
        frames.some(
          (frame) => wsBorsh.decodeEnvelope(frame).kind === wsBorsh.KIND_TMUX_SUBSCRIBE_PANES
        )
      ).toBe(true);
    } finally {
      if (prevPane === undefined) delete process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE;
      else process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE = prevPane;
    }
  });

  test('sends a resource_exhausted SourceGap for panes that cannot get a 16 KiB tail', () => {
    const replay = new StreamReplayState();
    const paneIds = Array.from({ length: 65 }, (_, i) => `%${i + 1}`);
    replay.noteOutbound(encodeSubscribe('dev-1', paneIds));
    const frames = replay.buildPostConnectFrames();
    const history = decodeHistoryRequests(frames);
    const gaps = decodeSourceGapPanes(replay.browserSignalFrames());
    expect(history.length + gaps.length).toBe(65);
    expect(history.length).toBeGreaterThan(0);
    expect(gaps.length).toBeGreaterThan(0);
    expect(history.every((row) => row.byteLimit >= 16 * 1024)).toBe(true);
    expect(history.reduce((sum, row) => sum + row.byteLimit, 0)).toBeLessThanOrEqual(1024 * 1024);
    expect(replay.legacyReplayStats().gapPanes).toEqual(gaps);
    expect(replay.legacyReplayStats().skippedPanes).toEqual([]);
  });

  test('does not cap canonical resume frames', () => {
    const replay = new StreamReplayState();
    const epoch = new Uint8Array(16);
    replay.noteOutbound(
      wsBorsh.encodeEnvelope(
        wsBorsh.KIND_CANONICAL_COMMAND,
        wsBorsh.encodeCanonicalCommandPayload({
          SetPaneSubscriptions: {
            generation: 1n,
            activePanes: [
              {
                pane: { deviceId: 'dev-1', serverEpoch: epoch, paneId: '%1' },
                cursor: { paneEpoch: epoch, terminalSeq: 0n },
              },
            ],
            hotPanes: [],
          },
        }),
        1
      )
    );
    const frames = replay.buildPostConnectFrames();
    expect(frames).toHaveLength(1);
    expect(replay.legacyReplayStats()).toEqual({
      replayBytes: 0,
      historyPanes: 0,
      skippedPanes: [],
      gapPanes: [],
    });
  });
});

describe('StreamReplayState canonical failover replay', () => {
  test('uses generation+1 and the latest PaneData cursor without legacy subscribe or history', () => {
    const replay = new StreamReplayState();
    const serverEpoch = new Uint8Array(16).fill(1);
    const paneEpoch = new Uint8Array(16).fill(2);
    const pane = { deviceId: 'dev-1', serverEpoch, paneId: '%1' };

    replay.noteOutbound(encodeDeviceConnect('dev-1'));
    replay.noteOutbound(encodeDeviceConnect('dev-2'));
    replay.noteOutbound(encodeSubscribe('dev-1', ['%1']));
    replay.noteOutbound(
      encodeCanonicalSubscription(7n, [{ pane, cursor: { paneEpoch, terminalSeq: 0n } }])
    );
    replay.noteOutbound(encodeSubscribe('dev-1', ['%legacy']));
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
    expect(replay.legacyReplayStats()).toEqual({
      replayBytes: 0,
      historyPanes: 0,
      skippedPanes: [],
      gapPanes: [],
    });
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
