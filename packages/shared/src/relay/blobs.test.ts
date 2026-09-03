import { describe, expect, it } from 'bun:test';
import {
  RELAY_STATUS_MAX_ENDPOINTS,
  decodeRelayOpenStream,
  decodeRelayRtcBlob,
  decodeRelayStatusBlob,
  encodeRelayOpenStream,
  encodeRelayRtcBlob,
  encodeRelayStatusBlob,
} from './blobs';
import { RelayCtlError } from './codec';

const NODE = 'ab'.repeat(16);

describe('relay 流 OPEN 首帧', () => {
  it('与 hub 的 {to} 完全一致', () => {
    const bytes = encodeRelayOpenStream({ to: NODE });
    expect(new TextDecoder().decode(bytes)).toBe(`{"to":"${NODE}"}`);
    expect(decodeRelayOpenStream(bytes)).toEqual({ to: NODE });
  });

  it('拒绝非 32-hex 目标与畸形 JSON', () => {
    expect(() => encodeRelayOpenStream({ to: 'x' })).toThrow(RelayCtlError);
    expect(() => decodeRelayOpenStream(new TextEncoder().encode('{"to":"x"}'))).toThrow(
      RelayCtlError
    );
    expect(() => decodeRelayOpenStream(new TextEncoder().encode('nope'))).toThrow(RelayCtlError);
  });
});

describe('relay.status 明文块', () => {
  const blob = {
    name: 'macbook',
    version: '1.1.23',
    tmux: true,
    direct_capable: true,
    inventory: { sessions: [{ name: 'main' }] },
    endpoints: [{ host: '10.0.0.2', port: 9663 }],
  };

  it('round-trip', () => {
    expect(decodeRelayStatusBlob(encodeRelayStatusBlob(blob))).toEqual(blob);
  });

  it('inventory / endpoints 缺省归一为 null', () => {
    const bare = {
      name: '',
      version: '1.1.23',
      tmux: false,
      direct_capable: false,
      inventory: undefined,
      endpoints: undefined,
    };
    expect(decodeRelayStatusBlob(encodeRelayStatusBlob(bare))).toEqual({
      name: '',
      version: '1.1.23',
      tmux: false,
      direct_capable: false,
      inventory: null,
      endpoints: null,
    });
  });

  it('拒绝超量 endpoints、超长 name 与畸形结构', () => {
    const endpoints = Array.from({ length: RELAY_STATUS_MAX_ENDPOINTS + 1 }, () => ({ host: 'h' }));
    expect(() => encodeRelayStatusBlob({ ...blob, endpoints })).toThrow(RelayCtlError);
    expect(() => encodeRelayStatusBlob({ ...blob, name: 'n'.repeat(257) })).toThrow(RelayCtlError);
    expect(() => encodeRelayStatusBlob({ ...blob, tmux: 'yes' as never })).toThrow(RelayCtlError);
    expect(() =>
      decodeRelayStatusBlob(new TextEncoder().encode('{"name":"a","version":1,"tmux":true}'))
    ).toThrow(RelayCtlError);
  });
});

describe('relay.rtc 明文块', () => {
  it('round-trip 且只保留出现的字段', () => {
    expect(decodeRelayRtcBlob(encodeRelayRtcBlob({ sdp: 'v=0' }))).toEqual({ sdp: 'v=0' });
    expect(decodeRelayRtcBlob(encodeRelayRtcBlob({ candidate: 'candidate:1' }))).toEqual({
      candidate: 'candidate:1',
    });
    expect(decodeRelayRtcBlob(encodeRelayRtcBlob({}))).toEqual({});
  });

  it('拒绝非字符串字段', () => {
    expect(() => encodeRelayRtcBlob({ sdp: 1 as never })).toThrow(RelayCtlError);
    expect(() => decodeRelayRtcBlob(new TextEncoder().encode('{"candidate":2}'))).toThrow(
      RelayCtlError
    );
  });
});
