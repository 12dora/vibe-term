import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';
import { UsageError } from '../core/errors';
import { routeFetch, testContext } from './cli-test-harness';
import { command as settings } from './settings';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RECORD = { ...WINDOW_MEMORY_SETTINGS_DEFAULTS };

async function jsonCtx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

async function humanCtx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: false });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm settings memory', () => {
  test('get --json prints the gateway payload', async () => {
    const { ctx, stdout } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
    });
    await settings.run(ctx, ['memory', 'get']);
    expect(JSON.parse(stdout.text())).toEqual(RECORD);
  });

  test('get prints key value lines', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/settings/window-memory': () => RECORD,
    });
    await settings.run(ctx, ['memory', 'get']);
    const text = stdout.text();
    expect(text).toContain('enabled');
    expect(text).toContain('true');
    expect(text).toContain('memoryHighMb');
    expect(text).toContain('8192');
    expect(text).toContain('memoryMaxMb');
    expect(text).toContain('12288');
    expect(text).toContain('memorySwapMaxMb');
    expect(text).toContain('4096');
    expect(text).toContain('sampleIntervalSec');
    expect(text).toContain('5');
  });

  test('set merges flags onto the current record and PUTs the full record', async () => {
    let put = '';
    const { ctx, stdout } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
      'PUT /api/settings/window-memory': (_url, init) => {
        put = String(init?.body);
        return { ...RECORD, enabled: false, memoryHighMb: 4096, sampleIntervalSec: 10 };
      },
    });
    await settings.run(ctx, [
      'memory',
      'set',
      '--enabled',
      'off',
      '--high',
      '4096',
      '--interval',
      '10',
    ]);
    expect(JSON.parse(put)).toEqual({
      ...RECORD,
      enabled: false,
      memoryHighMb: 4096,
      sampleIntervalSec: 10,
    });
    expect(JSON.parse(stdout.text())).toEqual({
      ...RECORD,
      enabled: false,
      memoryHighMb: 4096,
      sampleIntervalSec: 10,
    });
  });

  test('set --max --swap-max writes those fields', async () => {
    let put = '';
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
      'PUT /api/settings/window-memory': (_url, init) => {
        put = String(init?.body);
        return JSON.parse(String(init?.body));
      },
    });
    await settings.run(ctx, ['memory', 'set', '--max', '16384', '--swap-max', '2048']);
    expect(JSON.parse(put)).toEqual({
      ...RECORD,
      memoryMaxMb: 16384,
      memorySwapMaxMb: 2048,
    });
  });

  test('set rejects high > max when both are non-zero before PUT', async () => {
    let put = false;
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
      'PUT /api/settings/window-memory': () => {
        put = true;
        return RECORD;
      },
    });
    await expect(settings.run(ctx, ['memory', 'set', '--high', '20000'])).rejects.toBeInstanceOf(
      UsageError
    );
    expect(put).toBe(false);
  });

  test('set rejects a non-integer --high', async () => {
    let put = false;
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
      'PUT /api/settings/window-memory': () => {
        put = true;
        return RECORD;
      },
    });
    const error = await settings.run(ctx, ['memory', 'set', '--high', '1.5']).then(
      () => null,
      (err) => err as UsageError
    );
    expect(error).toBeInstanceOf(UsageError);
    expect(error?.exitCode).toBe(2);
    expect(put).toBe(false);
  });

  test('set rejects MB above 1048576', async () => {
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
    });
    await expect(settings.run(ctx, ['memory', 'set', '--max', '1048577'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('set rejects interval outside 2..60', async () => {
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
    });
    await expect(settings.run(ctx, ['memory', 'set', '--interval', '1'])).rejects.toBeInstanceOf(
      UsageError
    );
    await expect(settings.run(ctx, ['memory', 'set', '--interval', '61'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('set allows high=0 with a non-zero max', async () => {
    let put = '';
    const { ctx } = await jsonCtx({
      'GET /api/settings/window-memory': () => RECORD,
      'PUT /api/settings/window-memory': (_url, init) => {
        put = String(init?.body);
        return JSON.parse(String(init?.body));
      },
    });
    await settings.run(ctx, ['memory', 'set', '--high', '0']);
    expect(JSON.parse(put).memoryHighMb).toBe(0);
    expect(JSON.parse(put).memoryMaxMb).toBe(RECORD.memoryMaxMb);
  });

  test('unknown memory action is a usage error', async () => {
    const { ctx } = await jsonCtx({});
    await expect(settings.run(ctx, ['memory', 'reset'])).rejects.toBeInstanceOf(UsageError);
  });
});
