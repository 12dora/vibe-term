import { describe, expect, test } from 'bun:test';
import { classifyDirectDialFailure } from './direct-dial-breaker';

describe('classifyDirectDialFailure', () => {
  test('signaling-not-ready / primary-wait 不计入；其余按关键字归类', () => {
    expect(classifyDirectDialFailure('signaling not ready')).toBeNull();
    expect(classifyDirectDialFailure('connectionId: NO_CONNECTION')).toBeNull();
    expect(classifyDirectDialFailure('authorize failed (401)')).toBe('authorization');
    expect(classifyDirectDialFailure('connection lookup failed: offline')).toBe('lookup');
    expect(classifyDirectDialFailure('node DTLS fingerprint mismatch')).toBe('fingerprint');
    expect(classifyDirectDialFailure('direct connect timeout')).toBe('timeout');
    expect(classifyDirectDialFailure('ice disconnected')).toBe('ice');
    expect(classifyDirectDialFailure('switched back to primary')).toBe('carrier');
    expect(
      classifyDirectDialFailure('direct channel closed (carrier switch buffer overflow)')
    ).toBe('carrier');
    expect(classifyDirectDialFailure('direct channel closed by peer')).toBe('channel');
  });
});
