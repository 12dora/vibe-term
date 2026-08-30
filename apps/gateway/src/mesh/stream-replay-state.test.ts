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
