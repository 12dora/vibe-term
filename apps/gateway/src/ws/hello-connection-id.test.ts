import { describe, expect, test } from 'bun:test';
import { GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1 } from '@vibeterm/shared';
import {
  CONNECTION_ID_CAPABILITY_PREFIX,
  formatConnectionIdCapability,
  helloS2CCapabilities,
} from './hello-connection-id';

describe('HELLO_S2C connectionId 能力', () => {
  test('无 connectionId 时能力集与 2.3.0 一致', () => {
    const caps = helloS2CCapabilities(null);
    expect(caps).toContain(GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1);
    expect(caps.some((cap) => cap.startsWith(CONNECTION_ID_CAPABILITY_PREFIX))).toBe(false);
    expect(helloS2CCapabilities(undefined)).toEqual(caps);
    expect(helloS2CCapabilities('')).toEqual(caps);
  });

  test('有 connectionId 时追加 connection-id:<id>，不替换既有能力', () => {
    const caps = helloS2CCapabilities('conn-tab-1');
    expect(caps).toContain(GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1);
    expect(caps).toContain(formatConnectionIdCapability('conn-tab-1'));
  });
});
