import { describe, expect, test } from 'bun:test';
import {
  advertisedEndpointHost,
  deriveNodeAddress,
  displayHost,
  nodeReachLabel,
  nodeRelativeTime,
} from './node-address';

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

describe('displayHost', () => {
  test('剥 scheme 与 path，保留端口', () => {
    expect(displayHost('wss://office.example:39001/peer')).toBe('office.example:39001');
    expect(displayHost('https://hub.example.com')).toBe('hub.example.com');
    expect(displayHost('10.0.0.8:39001')).toBe('10.0.0.8:39001');
    expect(displayHost('  ')).toBeNull();
    expect(displayHost(null)).toBeNull();
  });
});

describe('advertisedEndpointHost', () => {
  test('优先非局域网，否则第一项', () => {
    expect(
      advertisedEndpointHost(['ws://10.0.0.8:39001/peer', 'wss://edge.example:39001/peer'])
    ).toBe('edge.example:39001');
    expect(advertisedEndpointHost(['ws://192.168.1.9:39001/peer'])).toBe('192.168.1.9:39001');
    expect(advertisedEndpointHost([])).toBeNull();
  });
});

describe('deriveNodeAddress', () => {
  test('pending 恒为空', () => {
    expect(deriveNodeAddress({ pending: true, hubPublicUrl: 'https://hub.example' })).toBeNull();
  });

  test('hub 用 publicUrl', () => {
    expect(
      deriveNodeAddress({
        isHub: true,
        hubPublicUrl: 'https://tokyo.example:8443',
        peerAddress: '10.0.0.2',
        transport: 'dc',
      })
    ).toBe('tokyo.example:8443');
  });

  test('live 直连用 peerAddress', () => {
    expect(
      deriveNodeAddress({
        transport: 'dc',
        peerAddress: '10.77.88.3',
        endpoints: ['wss://edge.example/peer'],
      })
    ).toBe('10.77.88.3');
    expect(
      deriveNodeAddress({
        transport: 'ws-secure',
        peerAddress: 'office.example',
      })
    ).toBe('office.example');
  });

  test('无直连时用广告 endpoint', () => {
    expect(
      deriveNodeAddress({
        transport: null,
        endpoints: ['ws://10.0.0.8:39001/peer', 'wss://edge.example:39001/peer'],
      })
    ).toBe('edge.example:39001');
  });

  test('中转用 viaRelay，否则 relayPresence', () => {
    expect(
      deriveNodeAddress({
        transport: 'relay',
        viaRelay: 'https://sh.example',
      })
    ).toBe('sh.example');
    expect(
      deriveNodeAddress({
        transport: 'ws-secure',
        relayPresence: ['https://ty.example'],
      })
    ).toBe('ty.example');
  });

  test('self 用本机 HTTPS/域名，否则空', () => {
    expect(deriveNodeAddress({ isSelf: true, selfAddress: 'https://home.example' })).toBe(
      'home.example'
    );
    expect(deriveNodeAddress({ isSelf: true })).toBeNull();
  });
});

describe('nodeReachLabel', () => {
  test('self / 离线 / pending 为空', () => {
    expect(
      nodeReachLabel({ isSelf: true, online: true, reach: 'lan', transport: 'dc' })
    ).toBeNull();
    expect(nodeReachLabel({ online: false, reach: 'lan', transport: 'dc' })).toBeNull();
    expect(nodeReachLabel({ pending: true, reach: 'lan', transport: 'dc' })).toBeNull();
  });

  test('直连拼 reach/transport，中转收成 relay', () => {
    expect(nodeReachLabel({ online: true, reach: 'lan', transport: 'dc' })).toBe('lan/dc');
    expect(nodeReachLabel({ online: true, reach: 'wan', transport: 'ws-secure' })).toBe(
      'wan/ws-secure'
    );
    expect(nodeReachLabel({ online: true, reach: 'relay', transport: 'relay' })).toBe('relay');
    expect(nodeReachLabel({ online: true, reach: 'relay', transport: null })).toBe('relay');
  });
});

describe('nodeRelativeTime', () => {
  const now = 1_700_000_000_000;

  test('分档', () => {
    expect(nodeRelativeTime(t, now - 1_000, now)).toBe('nodes.time.justNow');
    expect(nodeRelativeTime(t, now - 5 * MINUTE, now)).toBe('nodes.time.minutes:{"n":5}');
    expect(nodeRelativeTime(t, now - 3 * HOUR, now)).toBe('nodes.time.hours:{"n":3}');
    expect(nodeRelativeTime(t, now - 2 * DAY, now)).toBe('nodes.time.days:{"n":2}');
  });

  test('空值', () => {
    expect(nodeRelativeTime(t, null, now)).toBeNull();
    expect(nodeRelativeTime(t, 0, now)).toBeNull();
  });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
