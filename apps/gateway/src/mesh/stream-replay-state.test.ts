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
