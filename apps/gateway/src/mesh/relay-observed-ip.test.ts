import { describe, expect, test } from 'bun:test';
import { STUN_MAPPED_ADVERTISE_TTL_MS } from './peer-endpoints';
import { RELAY_OBSERVED_IPV4_TTL_MS, RelayObservedIpv4Store } from './relay-observed-ip';

const SH = 'https://tmexhub-sh.example/relay/uplink';
const JP = 'https://vt-relay-jp.example/relay/uplink';

describe('RelayObservedIpv4Store', () => {
  test('丢掉回环/私网，按 URL 记住公网观测', () => {
    const store = new RelayObservedIpv4Store();
    store.note(SH, '127.0.0.1');
    store.note(JP, '122.51.254.148');
    expect(store.snapshot()).toEqual(['122.51.254.148']);
  });

  test('断开失效；同一 URL 再 note 非法值也会清掉', () => {
    const store = new RelayObservedIpv4Store();
    store.note(JP, '122.51.254.148');
    store.drop(JP);
    expect(store.snapshot()).toEqual([]);
    store.note(JP, '122.51.254.148');
    store.note(JP, '10.0.0.3');
    expect(store.snapshot()).toEqual([]);
  });

  test('TTL 到期失效；touch 续期', () => {
    expect(RELAY_OBSERVED_IPV4_TTL_MS).toBe(STUN_MAPPED_ADVERTISE_TTL_MS);
    const store = new RelayObservedIpv4Store();
    const t0 = 1_000_000_000;
    store.note(JP, '122.51.254.148', t0);
    expect(store.snapshot(t0 + RELAY_OBSERVED_IPV4_TTL_MS + 1)).toEqual([]);
    store.note(JP, '122.51.254.148', t0);
    store.touch(JP, t0 + 60_000);
    expect(store.snapshot(t0 + RELAY_OBSERVED_IPV4_TTL_MS + 1)).toEqual(['122.51.254.148']);
  });

  test('URL 归一化后同一中继只留一条', () => {
    const store = new RelayObservedIpv4Store();
    store.note('https://Relay.Example/relay/uplink', '198.51.100.7');
    store.note('https://relay.example/relay/uplink/', '203.0.113.9');
    expect(store.snapshot()).toEqual(['203.0.113.9']);
  });
});
