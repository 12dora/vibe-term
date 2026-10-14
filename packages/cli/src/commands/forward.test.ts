import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { CliError, UsageError } from '../core/errors';
import { localHostId } from '../core/forward-names';
import type { FetchLike } from '../core/http';
import type { PortMapDto } from '../core/portmap-ops';
import { jsonResponse, testContext } from './cli-test-harness';
import { cleanupForwards, command as forward, holdForwards, pollForwards } from './forward';
import { NODE_A, NODE_B, entry, fakeGateway, findCall, mapDto } from './forward-fake-gateway';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 一个刚退出的子进程的 pid：确定不存在，且短时间内不会被复用。 */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

async function setup(fetchImpl: FetchLike, options: { json?: boolean } = {}) {
  const made = await testContext(fetchImpl, options);
  dirs.push(made.dir);
  return made;
}

describe('vibeterm forward --persist', () => {
  test('-L exports on the remote node and maps on the entry node', async () => {
    const fake = fakeGateway();
    const { ctx, stderr } = await setup(fake.fetch);
    await forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab']);

    expect(findCall(fake.calls, 'POST', NODE_B, '/api/portmap/exports')?.body).toEqual({
      fromNodeId: NODE_A,
      host: '127.0.0.1',
      port: 80,
    });
    expect(findCall(fake.calls, 'POST', 'self', '/api/portmap')?.body).toMatchObject({
      name: 'fwd:L8080',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      targetNodeId: NODE_B,
      targetHost: '127.0.0.1',
      targetPort: 80,
    });
    expect(fake.calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(stderr.text()).toContain('转发 127.0.0.1:8080 → lab 127.0.0.1:80');
    expect(stderr.text()).toContain('port ls');
  });

  test('-R exports on the entry node and maps on the remote node', async () => {
    const fake = fakeGateway();
    const { ctx, stderr } = await setup(fake.fetch);
    await forward.run(ctx, ['-R9000:[::1]:3000', '--persist', '--name', 'web', 'lab']);

    expect(findCall(fake.calls, 'POST', 'self', '/api/portmap/exports')?.body).toEqual({
      fromNodeId: NODE_B,
      host: '::1',
      port: 3000,
    });
    expect(findCall(fake.calls, 'POST', NODE_B, '/api/portmap')?.body).toMatchObject({
      name: 'web',
      listenHost: '127.0.0.1',
      listenPort: 9000,
      targetNodeId: NODE_A,
      targetHost: '::1',
      targetPort: 3000,
    });
    expect(stderr.text()).toContain('转发 lab 127.0.0.1:9000 → [::1]:3000');
    expect(stderr.text()).toContain('--on lab');
  });

  test('several forwards, bind forms and --json output', async () => {
    const fake = fakeGateway();
    const { ctx, stdout, stderr } = await setup(fake.fetch, { json: true });
    await forward.run(ctx, ['-N', '-L', '*:8080:h:80', '-R', '9000:h:90', '--persist', 'lab']);

    const created = fake.calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/portmap'
    );
    expect(created.map((call) => call.body?.name)).toEqual(['fwd:L8080', 'fwd:R9000']);
    expect(created[0].body?.listenHost).toBe('0.0.0.0');
    const out = JSON.parse(stdout.text()) as { forwards: Array<{ direction: string }> };
    expect(out.forwards.map((row) => row.direction)).toEqual(['L', 'R']);
    expect(stderr.text()).toBe('');
  });

  test('--name gets a per-forward suffix when there are several', async () => {
    const fake = fakeGateway();
    const { ctx } = await setup(fake.fetch);
    await forward.run(ctx, ['-L', '1:h:2', '-L', '3:h:4', '--persist', '--name', 'svc', 'lab']);
    const names = fake.calls
      .filter((call) => call.method === 'POST' && call.path === '/api/portmap')
      .map((call) => call.body?.name);
    expect(names).toEqual(['svc-L1', 'svc-L3']);
  });
});

describe('vibeterm forward validation', () => {
  test('rejects the entry node itself', async () => {
    const { ctx } = await setup(fakeGateway().fetch);
    for (const node of ['office', 'self']) {
      await expect(forward.run(ctx, ['-L', '1:h:2', '--persist', node])).rejects.toThrow(
        UsageError
      );
    }
  });

  test('requires a spec, one node and unique listen ports', async () => {
    const { ctx } = await setup(fakeGateway().fetch);
    await expect(forward.run(ctx, ['lab'])).rejects.toThrow(UsageError);
    await expect(forward.run(ctx, ['-L', '1:h:2'])).rejects.toThrow(UsageError);
    await expect(forward.run(ctx, ['-L', '1:h:2', 'a', 'b'])).rejects.toThrow(UsageError);
    await expect(forward.run(ctx, ['-L', '1:h:2', '-L', '1:g:3', 'lab'])).rejects.toThrow(
      UsageError
    );
    await expect(forward.run(ctx, ['-L', 'x:h:2', 'lab'])).rejects.toThrow(UsageError);
    await expect(forward.run(ctx, ['-L', '1:h:2', '--name', 'n', 'lab'])).rejects.toThrow(
      UsageError
    );
  });

  test('has help text with examples and is registered with the rewrite hook', () => {
    expect(forward.usage).toContain('vibeterm forward');
    expect(forward.usage).toContain('PermitListen');
    expect(forward.preprocessArgv?.(['-L8080:h:80', 'lab'])).toEqual(['--local=8080:h:80', 'lab']);
  });
});

describe('vibeterm forward rollback and stale cleanup', () => {
  test('rolls back the first forward when the second fails', async () => {
    const fake = fakeGateway({ failMapCreate: 2 });
    const { ctx } = await setup(fake.fetch);
    const error = (await forward
      .run(ctx, ['-L', '8080:h:80', '-R', '9000:h:90', '--persist', 'lab'])
      .catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error).not.toBeInstanceOf(UsageError);
    expect(findCall(fake.calls, 'DELETE', 'self', '/api/portmap/m1')).toBeDefined();
    expect(fake.maps.get('self')).toEqual([]);
    expect(fake.maps.get(NODE_B) ?? []).toEqual([]);
  });

  test('retries once after deleting a stale ephemeral forward with the same spec', async () => {
    const fake = fakeGateway({
      stale: [
        {
          node: 'self',
          map: {
            id: 'old1',
            name: `fwd:${localHostId()}:${(await deadPid()).toString(36)}:L8080`,
            listenHost: '127.0.0.1',
            listenPort: 8080,
            targetNodeId: NODE_B,
            targetHost: '127.0.0.1',
            targetPort: 80,
          },
        },
      ],
    });
    const { ctx } = await setup(fake.fetch);
    await forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab']);
    expect(findCall(fake.calls, 'DELETE', 'self', '/api/portmap/old1')).toBeDefined();
    expect(fake.maps.get('self')?.map((row) => row.name)).toEqual(['fwd:L8080']);
  });

  test('does not touch a persistent or different mapping', async () => {
    const base = {
      id: 'old1',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      targetNodeId: NODE_B,
      targetHost: '127.0.0.1',
      targetPort: 80,
    };
    const dead = `${localHostId()}:${(await deadPid()).toString(36)}`;
    for (const map of [
      { ...base, name: 'fwd:L8080' },
      { ...base, name: `fwd:${dead}:L8080`, targetPort: 81 },
    ]) {
      const fake = fakeGateway({ stale: [{ node: 'self', map }] });
      const { ctx } = await setup(fake.fetch);
      await expect(
        forward.run(ctx, ['-L', '8080:127.0.0.1:80', '--persist', 'lab'])
      ).rejects.toThrow(CliError);
      const deleted = fake.calls.some(
        (call) => call.method === 'DELETE' && call.path.endsWith('/old1')
      );
      expect(deleted).toBe(false);
    }
  });
});

describe('vibeterm forward foreground', () => {
  test('SIGTERM removes every forward it created and exits cleanly', async () => {
    const fake = fakeGateway();
    const { ctx, stderr } = await setup(fake.fetch);
    const running = forward.run(ctx, ['-L', '8080:h:80', '-R', '9000:h:90', 'lab']);
    for (let i = 0; i < 200 && (fake.maps.get(NODE_B)?.length ?? 0) === 0; i += 1) {
      await Bun.sleep(5);
    }
    const names = [...(fake.maps.get('self') ?? []), ...(fake.maps.get(NODE_B) ?? [])].map(
      (row) => row.name
    );
    const tag = process.pid.toString(36);
    const prefix = `fwd:${localHostId()}:${tag}`;
    expect(names).toEqual([`${prefix}:L8080`, `${prefix}:R9000`]);

    process.emit('SIGTERM');
    expect(await running).toBeUndefined();
    expect(fake.maps.get('self')).toEqual([]);
    expect(fake.maps.get(NODE_B)).toEqual([]);
    expect(stderr.text()).toContain('Ctrl-C');
  });

  test('cleanupForwards deletes maps in reverse order and reports failures', async () => {
    const fake = fakeGateway();
    const { ctx, stderr } = await setup(fake.fetch);
    await forward.run(ctx, ['-L', '1:h:2', '-R', '3:h:4', '--persist', 'lab']);
    const entries = [
      entry('L', 'self', NODE_B, fake.maps.get('self')?.[0] as PortMapDto),
      entry('R', NODE_B, 'self', fake.maps.get(NODE_B)?.[0] as PortMapDto),
    ];
    expect(await cleanupForwards(ctx, entries)).toBe(0);
    const deletes = fake.calls.filter(
      (call) => call.method === 'DELETE' && /portmap\/m\d$/.test(call.path)
    );
    expect(deletes.map((call) => call.path)).toEqual(['/api/portmap/m2', '/api/portmap/m1']);

    const again = await cleanupForwards(ctx, entries);
    expect(again).toBe(0);
    expect(stderr.text()).not.toContain('失败');
  });

  test('pollForwards warns once on error and reports recovery', async () => {
    let state: Partial<PortMapDto> = { state: 'error', error: 'port_in_use' };
    const map = mapDto({
      mapId: 'm1',
      name: 'x',
      listenHost: '127.0.0.1',
      listenPort: 8080,
      targetNodeId: NODE_B,
      targetHost: 'h',
      targetPort: 80,
    });
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(input);
      if (url.pathname === '/api/portmap') return jsonResponse({ maps: [{ ...map, ...state }] });
      return jsonResponse({ error: 'not_found' }, 404);
    };
    const { ctx, stderr } = await setup(fetchImpl);
    const entries = [entry('L', 'self', NODE_B, map)];
    const last = new Map<string, string>();

    await pollForwards(ctx, entries, last);
    await pollForwards(ctx, entries, last);
    expect(stderr.text().match(/端口被占用/g)).toHaveLength(1);

    state = { state: 'listening' };
    await pollForwards(ctx, entries, last);
    expect(stderr.text()).toContain('已恢复');
  });

  test('holdForwards polls until aborted', async () => {
    let polls = 0;
    const fetchImpl: FetchLike = async () => {
      polls += 1;
      return jsonResponse({ maps: [] });
    };
    const { ctx, stderr } = await setup(fetchImpl);
    const controller = new AbortController();
    const map = mapDto({
      mapId: 'm1',
      listenHost: '127.0.0.1',
      listenPort: 1,
      targetNodeId: NODE_B,
      targetHost: 'h',
      targetPort: 2,
    });
    const held = holdForwards(ctx, [entry('L', 'self', NODE_B, map)], {
      signal: controller.signal,
      pollMs: 5,
    });
    await Bun.sleep(40);
    controller.abort();
    await held;
    expect(polls).toBeGreaterThan(0);
    expect(stderr.text()).toContain('映射已不存在');
  });
});
