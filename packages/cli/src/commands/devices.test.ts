import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { UsageError } from '../core/errors';
import { NODE, routeFetch, testContext } from './cli-test-harness';
import { command as devices } from './devices';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const laptop = {
  id: 'd-1',
  name: 'laptop',
  type: 'local',
  authMode: 'auto',
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  lastSeenAt: null,
  lastError: null,
  lastErrorType: null,
  tmuxAvailable: true,
};

async function ctx(routes: Parameters<typeof routeFetch>[0], json = true) {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm devices', () => {
  test('ls lists devices on the entry', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/devices': () => ({ devices: [laptop] }),
    });
    await devices.run(cli, ['ls']);
    expect(JSON.parse(stdout.text()).devices[0].name).toBe('laptop');
  });

  test('add posts GUI form fields', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/devices': (_url, init) => {
        body = String(init?.body);
        return { device: laptop };
      },
    });
    await devices.run(cli, ['add', '--name', 'laptop', '--type', 'local']);
    expect(JSON.parse(body)).toMatchObject({ name: 'laptop', type: 'local', authMode: 'auto' });
  });

  test('edit patches by name', async () => {
    let path = '';
    const { ctx: cli } = await ctx({
      'GET /api/devices': () => ({ devices: [laptop] }),
      'PATCH /api/devices/d-1': (url, init) => {
        path = url.pathname;
        return { device: { ...laptop, name: String(JSON.parse(String(init?.body)).name) } };
      },
    });
    await devices.run(cli, ['edit', 'laptop', '--name', 'desk']);
    expect(path).toBe('/api/devices/d-1');
  });

  test('rm requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/devices': () => ({ devices: [laptop] }),
    });
    await expect(devices.run(cli, ['rm', 'laptop'])).rejects.toBeInstanceOf(UsageError);
  });

  test('test-connection posts', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/devices': () => ({ devices: [laptop] }),
      'POST /api/devices/d-1/test-connection': () => ({
        success: true,
        tmuxAvailable: true,
        phase: 'ready',
      }),
    });
    await devices.run(cli, ['test', 'laptop']);
    expect(JSON.parse(stdout.text()).success).toBe(true);
  });

  test('order puts ids', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PUT /api/devices/order': (_url, init) => {
        body = String(init?.body);
        return { devices: [laptop] };
      },
    });
    await devices.run(cli, ['order', '--ids', 'd-1,d-2']);
    expect(JSON.parse(body)).toEqual({ deviceIds: ['d-1', 'd-2'] });
  });

  test('folders ls hits /api/device-folders', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/device-folders': () => ({ folders: [], placements: [] }),
    });
    await devices.run(cli, ['folders', 'ls']);
    expect(JSON.parse(stdout.text()).folders).toEqual([]);
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
    await devices.run(built.ctx, ['ls']);
    expect(url).toBe(`http://entry.example:9883/n/${NODE}/api/devices`);
  });
});
