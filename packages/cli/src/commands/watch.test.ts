import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { UsageError } from '../core/errors';
import { routeFetch, testContext } from './cli-test-harness';
import { command as watch } from './watch';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const rule = {
  id: 'r-1',
  name: 'done',
  deviceId: 'd-1',
  paneId: '%0',
  enabled: true,
  triggerType: 'match',
};

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm watch', () => {
  test('rules ls requires device and pane', async () => {
    const { ctx: cli } = await ctx({});
    await expect(watch.run(cli, ['rules', 'ls'])).rejects.toBeInstanceOf(UsageError);
  });

  test('rules ls queries the list endpoint', async () => {
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/watch/rules': (url) => {
        path = `${url.pathname}?${url.searchParams}`;
        return { rules: [rule] };
      },
    });
    await watch.run(cli, ['rules', 'ls', '--device', 'd-1', '--pane', '%0']);
    expect(path).toContain('deviceId=d-1');
    expect(JSON.parse(stdout.text()).rules[0].id).toBe('r-1');
  });

  test('rules add posts a match rule', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/watch/rules': (_url, init) => {
        body = String(init?.body);
        return { rule, state: null };
      },
    });
    await watch.run(cli, [
      'rules',
      'add',
      '--name',
      'done',
      '--device',
      'd-1',
      '--pane',
      '%0',
      '--trigger-type',
      'match',
      '--pattern',
      'DONE',
    ]);
    expect(JSON.parse(body)).toMatchObject({
      name: 'done',
      deviceId: 'd-1',
      paneId: '%0',
      triggerType: 'match',
      pattern: 'DONE',
    });
  });

  test('rules state on patches enabled', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/watch/rules/r-1': (_url, init) => {
        body = String(init?.body);
        return { rule: { ...rule, enabled: false }, state: null };
      },
    });
    await watch.run(cli, ['rules', 'state', 'r-1', 'off']);
    expect(JSON.parse(body)).toEqual({ enabled: false });
  });

  test('assist-regex posts the description', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'POST /api/watch/assist-regex': (_url, init) => {
        body = String(init?.body);
        return { pattern: 'ERR', flags: '', extractGroup: 0, explanation: 'x', preview: [] };
      },
    });
    await watch.run(cli, ['assist-regex', 'error lines']);
    expect(JSON.parse(body).description).toBe('error lines');
    expect(JSON.parse(stdout.text()).pattern).toBe('ERR');
  });
});
