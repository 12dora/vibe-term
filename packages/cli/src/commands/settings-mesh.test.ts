import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { UsageError } from '../core/errors';
import { routeFetch, testContext } from './cli-test-harness';
import { command as settings } from './settings';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm settings mesh route-mode', () => {
  test('get prints the gateway payload', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/settings/mesh-route': () => ({ mode: 'auto' }),
    });
    await settings.run(cli, ['mesh', 'route-mode', 'get']);
    expect(JSON.parse(stdout.text())).toEqual({ mode: 'auto' });
  });

  test('set puts { mode } and prints the response', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'PUT /api/settings/mesh-route': (_url, init) => {
        body = String(init?.body);
        return { mode: 'relay' };
      },
    });
    await settings.run(cli, ['mesh', 'route-mode', 'set', 'relay']);
    expect(JSON.parse(body)).toEqual({ mode: 'relay' });
    expect(JSON.parse(stdout.text())).toEqual({ mode: 'relay' });
  });

  test('set rejects unknown modes before calling the gateway', async () => {
    let put = false;
    const { ctx: cli } = await ctx({
      'PUT /api/settings/mesh-route': () => {
        put = true;
        return { mode: 'auto' };
      },
    });
    await expect(
      settings.run(cli, ['mesh', 'route-mode', 'set', 'fastest'])
    ).rejects.toBeInstanceOf(UsageError);
    expect(put).toBe(false);
  });

  test('unknown mesh setting is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['mesh', 'latency', 'get'])).rejects.toBeInstanceOf(UsageError);
  });
});
