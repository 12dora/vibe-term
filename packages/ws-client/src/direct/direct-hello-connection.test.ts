import { describe, expect, test } from 'bun:test';
import {
  CONNECTION_ID_CAPABILITY_PREFIX,
  connectionIdFromCapabilities,
  formatConnectionIdCapability,
} from './direct-hello-connection';

describe('HELLO_S2C connectionId 能力串', () => {
  test('编出 connection-id:<id>，旧能力集里没有时回 null', () => {
    expect(formatConnectionIdCapability('conn-tab-1')).toBe(
      `${CONNECTION_ID_CAPABILITY_PREFIX}conn-tab-1`
    );
    expect(connectionIdFromCapabilities(undefined)).toBeNull();
    expect(connectionIdFromCapabilities([])).toBeNull();
    expect(connectionIdFromCapabilities(['canonical-state-v1.1'])).toBeNull();
  });

  test('从能力集取出 id；空值 / 只有前缀不算', () => {
    expect(
      connectionIdFromCapabilities([
        'canonical-state-v1.1',
        formatConnectionIdCapability('abc'),
        'device-latency-v1',
      ])
    ).toBe('abc');
    expect(connectionIdFromCapabilities([`${CONNECTION_ID_CAPABILITY_PREFIX}`])).toBeNull();
    expect(connectionIdFromCapabilities([`${CONNECTION_ID_CAPABILITY_PREFIX}   `])).toBeNull();
  });
});
