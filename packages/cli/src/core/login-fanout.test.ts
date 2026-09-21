import { describe, expect, test } from 'bun:test';
import { LOGIN_TIMEOUT } from './auth';
import { UsageError } from './errors';
import {
  emitLoginDone,
  emitLoginStart,
  formatNetworkSkipSummary,
  isNetworkLoginCode,
  mapBounded,
  networkSkipLabel,
  requirePositiveInt,
  takeTotpForRetry,
  totpRetryIndices,
} from './login-fanout';

describe('login fan-out helpers', () => {
  test('progress lines distinguish ok, timeout, unreachable and auth failure', () => {
    const lines: string[] = [];
    const out = { warn: (text: string) => lines.push(text) };
    emitLoginStart(out, 'office');
    emitLoginDone(out, 'office', { ok: true });
    emitLoginDone(out, 'stuck', { ok: false, code: LOGIN_TIMEOUT });
    emitLoginDone(out, 'oracle', { ok: false, code: 'NODE_UNREACHABLE' });
    emitLoginDone(out, 'home', { ok: false, code: 'INVALID_CREDENTIALS' });
    expect(lines).toEqual([
      'logging in to office ...',
      'logged in to office: ok',
      'skipped stuck: timeout',
      'skipped oracle: unreachable',
      'login to home failed: INVALID_CREDENTIALS',
    ]);
  });

  test('TIMEOUT and NODE_UNREACHABLE are network-class, auth codes are not', () => {
    expect(isNetworkLoginCode('NODE_UNREACHABLE')).toBe(true);
    expect(isNetworkLoginCode(LOGIN_TIMEOUT)).toBe(true);
    expect(isNetworkLoginCode('INVALID_CREDENTIALS')).toBe(false);
    expect(isNetworkLoginCode('TOTP_REQUIRED')).toBe(false);
    expect(networkSkipLabel(LOGIN_TIMEOUT)).toBe('timeout');
    expect(networkSkipLabel('NODE_UNREACHABLE')).toBe('unreachable');
  });

  test('skip summary keeps the singular noun and splits timeout from unreachable', () => {
    expect(formatNetworkSkipSummary(1, 1, 0)).toBe('logged in to 1 node, skipped 1 unreachable');
    expect(formatNetworkSkipSummary(2, 1, 0)).toBe('logged in to 2 nodes, skipped 1 unreachable');
    expect(formatNetworkSkipSummary(2, 0, 1)).toBe('logged in to 2 nodes, skipped 1 timeout');
    expect(formatNetworkSkipSummary(1, 1, 1)).toBe(
      'logged in to 1 node, skipped 1 unreachable, 1 timeout'
    );
  });

  test('requirePositiveInt falls back and rejects zero or fractions', () => {
    expect(requirePositiveInt('concurrency', undefined, 4)).toBe(4);
    expect(requirePositiveInt('node-timeout', 1500, 25_000)).toBe(1500);
    expect(() => requirePositiveInt('concurrency', 0, 4)).toThrow(UsageError);
    expect(() => requirePositiveInt('node-timeout', 1.5, 25_000)).toThrow(UsageError);
  });

  test('mapBounded preserves input order while overlapping slow work', async () => {
    const started: number[] = [];
    const items = ['slow', 'mid', 'fast'] as const;
    const delays = { slow: 80, mid: 40, fast: 10 };
    const results = await mapBounded(items, 3, async (item, index) => {
      started.push(Date.now());
      await Bun.sleep(delays[item]);
      return `${index}:${item}`;
    });
    expect(results).toEqual(['0:slow', '1:mid', '2:fast']);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(50);
  });

  test('totpRetryIndices only selects TOTP_REQUIRED rows', () => {
    expect(
      totpRetryIndices([
        { ok: true },
        { ok: false, code: 'TOTP_REQUIRED' },
        { ok: false, code: 'TIMEOUT' },
        { ok: false, code: 'TOTP_REQUIRED' },
      ])
    ).toEqual([1, 3]);
  });

  test('takeTotpForRetry prompts at most once and reuses the filled code', async () => {
    let prompts = 0;
    const totp = { code: null as string | null };
    const first = await takeTotpForRetry({
      totp,
      hasTotpKey: true,
      interactive: true,
      prompt: async () => {
        prompts += 1;
        return ' 123456 ';
      },
    });
    const second = await takeTotpForRetry({
      totp,
      hasTotpKey: true,
      interactive: true,
      prompt: async () => {
        prompts += 1;
        return '999999';
      },
    });
    expect(first).toBe('ready');
    expect(second).toBe('ready');
    expect(totp.code).toBe('123456');
    expect(prompts).toBe(1);
  });

  test('takeTotpForRetry does not prompt when non-interactive or missing k_totp', async () => {
    let prompts = 0;
    const prompt = async () => {
      prompts += 1;
      return '123456';
    };
    expect(
      await takeTotpForRetry({
        totp: { code: null },
        hasTotpKey: true,
        interactive: false,
        prompt,
      })
    ).toBe('missing');
    expect(
      await takeTotpForRetry({
        totp: { code: null },
        hasTotpKey: false,
        interactive: true,
        prompt,
      })
    ).toBe('unavailable');
    expect(prompts).toBe(0);
  });
});
