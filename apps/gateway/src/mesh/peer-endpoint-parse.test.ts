import { describe, expect, test } from 'bun:test';
import { PEER_WS_PATH, isAllowedPeerEndpoint, sanitizeEndpoints } from './peer-endpoint-parse';

describe('sanitizeEndpoints / isAllowedPeerEndpoint', () => {
  test('只接受 ws/wss、路径 /peer、无 userinfo/query/fragment', () => {
    expect(PEER_WS_PATH).toBe('/peer');
    expect(isAllowedPeerEndpoint('ws://10.0.0.8:39001/peer')).toBe(true);
    expect(isAllowedPeerEndpoint('wss://peer.example.com:39001/peer')).toBe(true);
    expect(isAllowedPeerEndpoint('https://10.0.0.8:39001/peer')).toBe(false);
    expect(isAllowedPeerEndpoint('ws://10.0.0.8:39001/relay/uplink')).toBe(false);
    expect(isAllowedPeerEndpoint('ws://user:pass@10.0.0.8:39001/peer')).toBe(false);
    expect(isAllowedPeerEndpoint('ws://10.0.0.8:39001/peer?x=1')).toBe(false);
    expect(isAllowedPeerEndpoint('ws://10.0.0.8:39001/peer#frag')).toBe(false);
  });

  test('丢弃未指定 / 链路本地 / 组播，保留回环（同机多节点）与 RFC1918', () => {
    expect(sanitizeEndpoints(['ws://127.0.0.1:39001/peer'])).toEqual(['ws://127.0.0.1:39001/peer']);
    expect(sanitizeEndpoints(['ws://localhost:39001/peer'])).toEqual(['ws://localhost:39001/peer']);
    expect(sanitizeEndpoints(['ws://0.0.0.0:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://[::]:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://169.254.1.1:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://[fe80::1]:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://224.0.0.1:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://[ff02::1]:39001/peer'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://10.0.0.8:39001/peer'])).toEqual(['ws://10.0.0.8:39001/peer']);
    expect(sanitizeEndpoints(['ws://192.168.1.4:39001/peer'])).toEqual([
      'ws://192.168.1.4:39001/peer',
    ]);
    expect(sanitizeEndpoints(['ws://172.16.0.2:39001/peer'])).toEqual([
      'ws://172.16.0.2:39001/peer',
    ]);
  });

  test('攻击载荷：javascript / 非 /peer 路径 / 超长串一律丢掉', () => {
    expect(sanitizeEndpoints(['javascript:alert(1)'])).toEqual([]);
    expect(sanitizeEndpoints(['ws://10.0.0.8:39001/peer/../admin'])).toEqual([]);
    expect(sanitizeEndpoints([`ws://10.0.0.8:39001/${'x'.repeat(300)}`])).toEqual([]);
  });
});
