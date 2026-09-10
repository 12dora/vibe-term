import { describe, expect, test } from 'bun:test';
import { requireLiveEnv } from '../../test-support/live-env';
import { probeStunServer } from './stun-probe';

// 打真实 STUN endpoint。默认 bun test 不发现 *.integration.ts。
// 显式跑：bun run --filter @vibeterm/gateway test:live:stun
requireLiveEnv(
  ['VIBETERM_LIVE_STUN'],
  '在 env/test.env.local 设置 VIBETERM_LIVE_STUN=1 以打真实 STUN（默认 stun.miwifi.com:3478）。'
);

describe('stun-probe live', () => {
  test(
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
