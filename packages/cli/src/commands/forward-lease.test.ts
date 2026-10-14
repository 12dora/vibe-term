import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { CliError } from '../core/errors';
import { EPHEMERAL_NAME_RE, localHostId } from '../core/forward-names';
import type { FetchLike } from '../core/http';
import { createPortMappingDetailed } from '../core/portmap-ops';
import { jsonResponse, testContext } from './cli-test-harness';
import { command as forward, holdForwards, renewForwardLeases } from './forward';
import { type FakeOptions, NODE_B, entry, fakeGateway, findCall } from './forward-fake-gateway';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(fetchImpl: FetchLike) {
  const made = await testContext(fetchImpl);
  dirs.push(made.dir);
  return made;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) await Bun.sleep(5);
}

const INPUT = {
  listenNodeId: 'self',
  targetNodeId: NODE_B,
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
};

/** 与前台转发建立的一致：带租约的映射 + 放行，flags 取自网关响应。 */
async function leasedEntry(ctx: Awaited<ReturnType<typeof setup>>['ctx']) {
  const created = await createPortMappingDetailed(ctx, { ...INPUT, name: 'x', leaseMs: 90_000 });
  return entry('L', 'self', NODE_B, created.map, {
    mapLeased: created.map.leaseExpiresAt !== undefined,
    exportLeased: created.exported.leaseExpiresAt !== undefined,
  });
}

async function runForeground(options: FakeOptions, argv: string[]) {
  const fake = fakeGateway(options);
  const made = await setup(fake.fetch);
  const running = forward.run(made.ctx, argv);
  await waitFor(() => made.stderr.text().includes('转发已就绪'));
  const stop = async () => {
    process.emit('SIGTERM');
    return running;
  };
  return { fake, ...made, stop };
}

describe('foreground forward leases', () => {
  test('creates a leased export and map with a host-id name', async () => {
    const run = await runForeground({}, ['-L', '8080:127.0.0.1:80', 'lab']);
    const exportBody = findCall(run.fake.calls, 'POST', NODE_B, '/api/portmap/exports')?.body;
    const mapBody = findCall(run.fake.calls, 'POST', 'self', '/api/portmap')?.body;
    expect(exportBody?.leaseMs).toBe(90_000);
    expect(mapBody?.leaseMs).toBe(90_000);
    expect(String(mapBody?.name)).toMatch(EPHEMERAL_NAME_RE);
    expect(String(mapBody?.name)).toContain(`fwd:${localHostId()}:`);
    expect(run.stderr.text()).not.toContain('网关版本较旧');
    expect(await run.stop()).toBeUndefined();
    expect(run.fake.maps.get('self')).toEqual([]);
  });

  test('--persist creates without any lease', async () => {
    const fake = fakeGateway();
    const { ctx, stderr } = await setup(fake.fetch);
    await forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab']);
    expect(findCall(fake.calls, 'POST', NODE_B, '/api/portmap/exports')?.body).not.toHaveProperty(
      'leaseMs'
    );
    expect(findCall(fake.calls, 'POST', 'self', '/api/portmap')?.body).not.toHaveProperty(
      'leaseMs'
    );
    expect(stderr.text()).not.toContain('租约');
  });

  test('an old gateway ignoring leaseMs gets one concise warning', async () => {
    const run = await runForeground({ legacyNodes: [NODE_B] }, [
      '-L',
      '8080:h:80',
      '-L',
      '8081:h:81',
      'lab',
    ]);
    expect(run.stderr.text().match(/网关版本较旧/g)).toHaveLength(1);
    expect(run.stderr.text()).toContain('lab');
    await run.stop();
  });

  test('Ctrl-C during setup stops creating, cleans up and never says ready', async () => {
    const fake = fakeGateway();
    let fired = false;
    const fetchImpl: FetchLike = async (input, init) => {
      const response = await fake.fetch(input, init);
      const isExport =
        (init?.method ?? 'GET') === 'POST' && String(input).endsWith('/portmap/exports');
      if (isExport && !fired) {
        fired = true;
        process.emit('SIGTERM');
      }
      return response;
    };
    const { ctx, stderr } = await setup(fetchImpl);
    const result = await forward.run(ctx, ['-L', '1:h:2', '-L', '3:h:4', 'lab']);
    expect(result).toBeUndefined();
    expect(stderr.text()).not.toContain('转发已就绪');
    expect(fake.maps.get('self')).toEqual([]);
    const created = fake.calls.filter((c) => c.method === 'POST' && c.path === '/api/portmap');
    expect(created).toHaveLength(1);
  });
});

describe('lease renewal loop', () => {
  test('renews both the map and the export every interval', async () => {
    const fake = fakeGateway();
    const { ctx } = await setup(fake.fetch);
    const leased = await leasedEntry(ctx);
    expect(leased.mapLeased && leased.exportLeased).toBe(true);
    const controller = new AbortController();
    const held = holdForwards(ctx, [leased], {
      signal: controller.signal,
      pollMs: 5,
      leaseMs: 45_000,
    });
    const renewals = () =>
      fake.calls.filter((c) => c.method === 'PATCH' && c.body?.leaseMs === 45_000);
    await waitFor(() => renewals().length >= 4);
    controller.abort();
    await held;
    expect(findCall(renewals(), 'PATCH', 'self', `/api/portmap/${leased.map.id}`)).toBeDefined();
    expect(
      findCall(renewals(), 'PATCH', NODE_B, `/api/portmap/exports/${leased.map.id}`)
    ).toBeDefined();
  });

  test('entries without a lease are never renewed', async () => {
    const fake = fakeGateway({ legacyNodes: ['self', NODE_B] });
    const { ctx } = await setup(fake.fetch);
    const old = await leasedEntry(ctx);
    expect(old.mapLeased || old.exportLeased).toBe(false);
    await renewForwardLeases(ctx, [old], 90_000, new Set());
    expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('a failing renewal warns once and recovers silently', async () => {
    const fake = fakeGateway();
    let broken = false;
    const fetchImpl: FetchLike = async (input, init) =>
      broken && init?.method === 'PATCH' && String(input).includes('/portmap/exports/')
        ? jsonResponse({ error: 'boom' }, 500)
        : fake.fetch(input, init);
    const { ctx, stderr } = await setup(fetchImpl);
    const leased = await leasedEntry(ctx);
    const failing = new Set<string>();
    broken = true;
    await renewForwardLeases(ctx, [leased], 90_000, failing);
    await renewForwardLeases(ctx, [leased], 90_000, failing);
    expect(stderr.text().match(/放行行续约失败/g)).toHaveLength(1);
    expect(failing.size).toBe(1);
    broken = false;
    await renewForwardLeases(ctx, [leased], 90_000, failing);
    expect(failing.size).toBe(0);
    expect(stderr.text().match(/续约失败/g)).toHaveLength(1);
  });
});

describe('stale reclaim only for this host', () => {
  const base = {
    id: 'old1',
    listenHost: '127.0.0.1',
    listenPort: 8080,
    targetNodeId: NODE_B,
    targetHost: '127.0.0.1',
    targetPort: 80,
  };

  async function exitedPid(): Promise<number> {
    const child = Bun.spawn(['true']);
    await child.exited;
    return child.pid;
  }

  test('keeps another host live forward, even when its pid is dead locally', async () => {
    const pid = (await exitedPid()).toString(36);
    const fake = fakeGateway({
      stale: [{ node: 'self', map: { ...base, name: `fwd:deadbeef:${pid}:L8080` } }],
    });
    const { ctx } = await setup(fake.fetch);
    await expect(forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab'])).rejects.toThrow(
      CliError
    );
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/old1'))).toBe(false);
  });

  test('keeps a local forward whose owner is still alive', async () => {
    const alive = process.ppid.toString(36);
    const fake = fakeGateway({
      stale: [{ node: 'self', map: { ...base, name: `fwd:${localHostId()}:${alive}:L8080` } }],
    });
    const { ctx } = await setup(fake.fetch);
    await expect(forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab'])).rejects.toThrow(
      CliError
    );
    expect(fake.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/old1'))).toBe(false);
  });
});
