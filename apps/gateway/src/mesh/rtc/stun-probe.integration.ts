import { describe, expect, test } from 'bun:test';
import { probeStunServer } from './stun-probe';

// 打真实 STUN endpoint。默认 bun test 不发现 *.integration.ts。
// 显式跑：VIBETERM_LIVE_STUN=1 bun test ./src/mesh/rtc/stun-probe.integration.ts
const live = Boolean(process.env.VIBETERM_LIVE_STUN?.trim());

describe('stun-probe live', () => {
  test.if(live)(
    'Binding to stun.miwifi.com returns a mapped address',
    async () => {
      const result = await probeStunServer('stun:stun.miwifi.com:3478');
      expect(result.ok).toBe(true);
      expect(result.mappedAddress).toBeTruthy();
      expect(result.rttMs).toBeGreaterThanOrEqual(0);
    },
    { timeout: 8_000 }
  );
});
