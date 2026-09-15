import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { formatBytes } from '@vibeterm/shared';
import { UsageError } from '../core/errors';
import { NODE, routeFetch, testContext } from './cli-test-harness';
import { command as sessions } from './sessions';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PAYLOAD = {
  devices: [
    {
      deviceId: 'dev-linux',
      deviceName: 'linux',
      supported: true,
      windows: [
        {
          windowId: '@1',
          windowName: 'build',
          panes: 2,
          scopes: ['tmux-spawn-aaa.scope', 'tmux-spawn-bbb.scope'],
          current: 1024 ** 3,
          high: 8 * 1024 ** 3,
          max: 12 * 1024 ** 3,
          swapMax: 4 * 1024 ** 3,
          oomKills: 3,
          oomFlag: true,
          sampledAt: 1,
        },
        {
          windowId: '@2',
          windowName: 'main',
          panes: 1,
          scopes: ['tmux-spawn-ccc.scope'],
          current: 512,
          high: 0,
          max: 0,
          swapMax: 0,
          oomKills: 0,
          oomFlag: false,
          sampledAt: 1,
        },
      ],
    },
    {
      deviceId: 'dev-mac',
      deviceName: 'macbook',
      supported: false,
      windows: [],
    },
  ],
};

async function jsonCtx(routes: Parameters<typeof routeFetch>[0], options: { node?: string } = {}) {
  const built = await testContext(routeFetch(routes), { json: true, ...options });
  dirs.push(built.dir);
  return built;
}

async function humanCtx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: false });
  Object.assign(built.stdout.stream, { isTTY: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm sessions', () => {
  test('USAGE names the group', () => {
    expect(sessions.usage).toContain('vibeterm sessions');
    expect(sessions.name).toBe('sessions');
  });

  test('table without --memory lists DEVICE WINDOW PANES', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, []);
    const text = stdout.text();
    expect(text).toContain('DEVICE');
    expect(text).toContain('WINDOW');
    expect(text).toContain('PANES');
    expect(text).not.toContain('SCOPE');
    expect(text).not.toContain('MEM');
    expect(text).toContain('linux');
    expect(text).toContain('@1 build');
    expect(text).toContain('@2 main');
    expect(text).not.toContain('(memory limits unsupported on this host)');
    expect(text).not.toContain('macbook');
  });

  test('table with --memory adds SCOPE MEM HIGH MAX OOM', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('SCOPE');
    expect(text).toContain('MEM');
    expect(text).toContain('HIGH');
    expect(text).toContain('MAX');
    expect(text).toContain('OOM');
    expect(text).toContain('tmux-spawn-aaa.scope+1');
    expect(text).toContain('tmux-spawn-ccc.scope');
    expect(text).toContain(formatBytes(1024 ** 3));
    expect(text).toContain(formatBytes(8 * 1024 ** 3));
    expect(text).toContain('∞');
    expect(text).toContain('3!');
    expect(text).toMatch(/\b0\b/);
  });

  test('unsupported device prints a note after its rows in --memory mode', async () => {
    const { ctx, stdout } = await humanCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    const text = stdout.text();
    expect(text).toContain('macbook');
    expect(text).toContain('(memory limits unsupported on this host)');
    const linuxIdx = text.indexOf('linux');
    const macIdx = text.indexOf('macbook');
    const noteIdx = text.indexOf('(memory limits unsupported on this host)');
    expect(linuxIdx).toBeGreaterThanOrEqual(0);
    expect(macIdx).toBeGreaterThan(linuxIdx);
    expect(noteIdx).toBeGreaterThan(macIdx);
  });

  test('--json prints the gateway payload unchanged', async () => {
    const { ctx, stdout } = await jsonCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await sessions.run(ctx, ['--memory']);
    expect(JSON.parse(stdout.text())).toEqual(PAYLOAD);
  });

  test('non-TTY stdout defaults to JSON', async () => {
    const { ctx, stdout } = await testContext(
      routeFetch({
        'GET /api/sessions/memory': () => PAYLOAD,
      }),
      { json: false }
    );
    dirs.push(ctx.configDir);
    await sessions.run(ctx, []);
    expect(JSON.parse(stdout.text())).toEqual(PAYLOAD);
  });

  test('--node prefixes /n/<id>', async () => {
    let url = '';
    const built = await testContext(
      async (requested) => {
        url = requested;
        return new Response(JSON.stringify({ devices: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      },
      { json: true, node: NODE }
    );
    dirs.push(built.dir);
    await sessions.run(built.ctx, []);
    expect(url).toBe(`http://entry.example:9883/n/${NODE}/api/sessions/memory`);
  });

  test('unexpected arguments are a usage error', async () => {
    const { ctx } = await jsonCtx({
      'GET /api/sessions/memory': () => PAYLOAD,
    });
    await expect(sessions.run(ctx, ['ls'])).rejects.toBeInstanceOf(UsageError);
  });
});
