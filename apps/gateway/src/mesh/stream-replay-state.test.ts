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

describe('StreamReplayState legacy failover history cap', () => {
  test('caps history requests per pane and in total, skipping extras for a fresh screen', () => {
    const prevPane = process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE;
    process.env.TMEX_FAILOVER_HISTORY_BYTES_PER_PANE = String(256 * 1024);
    try {
      const replay = new StreamReplayState();
      replay.noteOutbound(encodeSubscribe('dev-1', ['%1', '%2', '%3', '%4', '%5']));
      const frames = replay.buildPostConnectFrames();
      const history = frames.filter((frame) => {
        try {
          return wsBorsh.decodeEnvelope(frame).kind === wsBorsh.KIND_TMUX_FETCH_PANE_HISTORY;
        } catch {
          return false;
        }
      });
      expect(history).toHaveLength(4);
      expect(replay.legacyReplayStats()).toEqual({
        replayBytes: 1024 * 1024,
        historyPanes: 4,
        skippedPanes: ['%5'],
      });
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
    });
  });
});
