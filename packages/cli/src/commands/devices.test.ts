import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../core/errors';
import { FAKE_DEVICE_ID, createFakeTermContext, fakeSession } from '../core/term-test-fakes';
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

  test('add --password on argv warns and still sends the secret', async () => {
    let body = '';
    const { ctx: cli, stderr } = await ctx({
      'POST /api/devices': (_url, init) => {
        body = String(init?.body);
        return { device: laptop };
      },
    });
    await devices.run(cli, ['add', '--name', 'laptop', '--type', 'ssh', '--password', 's3cret']);
    expect(JSON.parse(body)).toMatchObject({ password: 's3cret' });
    expect(stderr.text()).toContain('visible to other processes');
  });

  test('add --password-file reads the secret without argv warning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-secret-'));
    dirs.push(dir);
    const file = join(dir, 'pw');
    await writeFile(file, 'from-file\n');
    let body = '';
    const { ctx: cli, stderr } = await ctx({
      'POST /api/devices': (_url, init) => {
        body = String(init?.body);
        return { device: laptop };
      },
    });
    await devices.run(cli, ['add', '--name', 'laptop', '--type', 'ssh', '--password-file', file]);
    expect(JSON.parse(body)).toMatchObject({ password: 'from-file' });
    expect(stderr.text()).not.toContain('visible to other processes');
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

  test('folders rename patches /api/device-folders/:id', async () => {
    let path = '';
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'PATCH /api/device-folders/f-1': (url, init) => {
        path = url.pathname;
        body = String(init?.body);
        return { folder: { id: 'f-1', name: 'ops' } };
      },
    });
    await devices.run(cli, ['folders', 'rename', 'f-1', '--name', 'ops']);
    expect(path).toBe('/api/device-folders/f-1');
    expect(JSON.parse(body)).toEqual({ name: 'ops' });
    expect(JSON.parse(stdout.text()).folder.name).toBe('ops');
  });

  test('folders reset requires --yes off-tty and posts /api/device-folders/reset', async () => {
    const missing = await ctx({
      'POST /api/device-folders/reset': () => ({ folders: [], placements: [] }),
    });
    await expect(devices.run(missing.ctx, ['folders', 'reset'])).rejects.toBeInstanceOf(UsageError);
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'POST /api/device-folders/reset': (url) => {
        path = url.pathname;
        return { folders: [], placements: [] };
      },
    });
    await devices.run(cli, ['folders', 'reset', '--yes']);
    expect(path).toBe('/api/device-folders/reset');
    expect(JSON.parse(stdout.text()).folders).toEqual([]);
  });

  test('connect sends WS connect-device and waits for device-connected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-devices-ws-'));
    dirs.push(dir);
    const h = createFakeTermContext({
      session: fakeSession(),
      configDir: dir,
      json: true,
      timeoutMs: 1_000,
    });
    await devices.run(h.ctx, ['connect', 'laptop', '--once']);
    expect(h.transport.commandsOfType('connect-device')[0]).toMatchObject({
      deviceId: FAKE_DEVICE_ID,
    });
    expect(h.transport.commandsOfType('disconnect-device')).toHaveLength(0);
    expect(JSON.parse(h.stdout.text().trim())).toEqual({
      ok: true,
      action: 'connected',
      id: FAKE_DEVICE_ID,
      hold: false,
    });
    expect(h.closed()).toBe(1);
  });

  test('connect without --once holds the socket until SIGINT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-devices-ws-'));
    dirs.push(dir);
    const h = createFakeTermContext({
      session: fakeSession(),
      configDir: dir,
      json: true,
      timeoutMs: 1_000,
    });
    const run = devices.run(h.ctx, ['connect', 'laptop']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.closed()).toBe(0);
    expect(JSON.parse(h.stdout.text().trim())).toMatchObject({ action: 'connected', hold: true });
    process.emit('SIGINT');
    await run;
    expect(h.closed()).toBe(1);
  });

  test('disconnect sends WS disconnect-device without connect-device', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-devices-ws-'));
    dirs.push(dir);
    const h = createFakeTermContext({
      session: fakeSession(),
      configDir: dir,
      json: true,
      timeoutMs: 1_000,
    });
    h.transport.onCommand = (command) => {
      if (command.type !== 'disconnect-device') return;
      queueMicrotask(() =>
        h.transport.emit({ type: 'device-disconnected', deviceId: command.deviceId })
      );
    };
    await devices.run(h.ctx, ['disconnect', 'laptop']);
    expect(h.transport.commandsOfType('connect-device')).toHaveLength(0);
    expect(h.transport.commandsOfType('disconnect-device')[0]).toMatchObject({
      deviceId: FAKE_DEVICE_ID,
    });
    expect(JSON.parse(h.stdout.text().trim())).toEqual({
      ok: true,
      action: 'disconnected',
      id: FAKE_DEVICE_ID,
    });
    expect(h.closed()).toBe(1);
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
