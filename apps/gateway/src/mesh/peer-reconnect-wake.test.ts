import { describe, expect, test } from 'bun:test';
import { DC_PRESENCE_ABSENCE_MS, RelayPresenceGap } from './peer-reconnect-wake';

describe('RelayPresenceGap', () => {
  test('absence longer than the presence stale window is a return', () => {
    const gap = new RelayPresenceGap();
    const peer = 'ec42f364';
    expect(gap.observe(peer, false, 10)).toBe('absent');
    expect(gap.observe(peer, false, 20)).toBe('absent');
    expect(gap.observe(peer, true, 10 + DC_PRESENCE_ABSENCE_MS)).toBe('returned');
    expect(gap.observe(peer, true, 10 + DC_PRESENCE_ABSENCE_MS + 1)).toBe('unchanged');
  });
});
