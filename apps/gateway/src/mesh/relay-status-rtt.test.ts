import { describe, expect, test } from 'bun:test';
import { rttChangedMaterially, statusBlobWithoutRtt } from './relay-status-rtt';

describe('rttChangedMaterially', () => {
  test('从无样本到有样本算变化；小抖动忽略；≥20% 且 ≥15ms 才算', () => {
    expect(rttChangedMaterially(null, 20)).toBe(true);
    expect(rttChangedMaterially(100, 110)).toBe(false);
    expect(rttChangedMaterially(100, 121)).toBe(true);
    expect(rttChangedMaterially(50, 60)).toBe(false);
    expect(rttChangedMaterially(50, 70)).toBe(true);
    expect(rttChangedMaterially(10, null)).toBe(false);
  });
});

describe('statusBlobWithoutRtt', () => {
  test('去掉 rtt_ms 保留其余字段', () => {
    expect(
      statusBlobWithoutRtt({
        name: 'n',
        version: '1',
        tmux: false,
        direct_capable: true,
        inventory: null,
        endpoints: null,
        rtt_ms: 12,
      })
    ).toEqual({
      name: 'n',
      version: '1',
      tmux: false,
      direct_capable: true,
      inventory: null,
      endpoints: null,
    });
  });
});
