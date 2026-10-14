import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { testContext } from '../commands/cli-test-harness';
import { NODE_B, fakeGateway, findCall } from '../commands/forward-fake-gateway';
import {
  type CreatePortMapInput,
  createPortMapping,
  createPortMappingDetailed,
  patchPortMap,
  renewPortExportLease,
} from './portmap-ops';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const INPUT: CreatePortMapInput = {
  listenNodeId: 'self',
  targetNodeId: NODE_B,
  listenHost: '127.0.0.1',
  listenPort: 8080,
  targetHost: '127.0.0.1',
  targetPort: 80,
  name: 'pg',
};

async function setup(options: Parameters<typeof fakeGateway>[0] = {}) {
  const fake = fakeGateway(options);
  const made = await testContext(fake.fetch);
  dirs.push(made.dir);
  return { fake, ...made };
}

describe('portmap ops leases', () => {
  test('leaseMs goes to both the export and the map and comes back on both', async () => {
    const { fake, ctx } = await setup({ now: 5_000 });
    const created = await createPortMappingDetailed(ctx, { ...INPUT, leaseMs: 90_000 });
    expect(findCall(fake.calls, 'POST', NODE_B, '/api/portmap/exports')?.body?.leaseMs).toBe(
      90_000
    );
    expect(findCall(fake.calls, 'POST', 'self', '/api/portmap')?.body?.leaseMs).toBe(90_000);
    expect(created.exported.leaseExpiresAt).toBe(95_000);
    expect(created.map.leaseExpiresAt).toBe(95_000);
  });

  test('without leaseMs nothing lease-related is sent and createPortMapping returns the map', async () => {
    const { fake, ctx } = await setup();
    const map = await createPortMapping(ctx, INPUT);
    expect(map.leaseExpiresAt).toBeUndefined();
    for (const call of fake.calls.filter((c) => c.method === 'POST' && c.body)) {
      expect(call.body).not.toHaveProperty('leaseMs');
    }
  });

  test('a gateway that ignores leaseMs yields no leaseExpiresAt', async () => {
    const { ctx } = await setup({ legacyNodes: ['self', NODE_B] });
    const created = await createPortMappingDetailed(ctx, { ...INPUT, leaseMs: 90_000 });
    expect(created.map.leaseExpiresAt).toBeUndefined();
    expect(created.exported.leaseExpiresAt).toBeUndefined();
  });

  test('renewals PATCH the map and the export with leaseMs', async () => {
    const { fake, ctx } = await setup({ now: 5_000 });
    const created = await createPortMappingDetailed(ctx, { ...INPUT, leaseMs: 90_000 });
    const id = created.map.id;
    const map = await patchPortMap(ctx, 'self', id, { leaseMs: 60_000 });
    const exported = await renewPortExportLease(ctx, NODE_B, id, 60_000);
    expect(map.leaseExpiresAt).toBe(65_000);
    expect(exported.leaseExpiresAt).toBe(65_000);
    expect(findCall(fake.calls, 'PATCH', NODE_B, `/api/portmap/exports/${id}`)?.body).toEqual({
      leaseMs: 60_000,
    });
  });
});
