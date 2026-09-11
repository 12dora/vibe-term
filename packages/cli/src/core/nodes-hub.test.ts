import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { NODE, meshNode, routeFetch, testContext } from '../commands/cli-test-harness';
import { NotFoundError, UsageError } from './errors';
import { findAdminNode } from './nodes-hub';

const dirs: string[] = [];
const HUB = 'b'.repeat(32);

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built.ctx;
}

function hubRow(partial: { id: string; name: string; admission_status?: 'pending' | 'admitted' }) {
  return {
    status: 'admitted',
    online: true,
    version: null,
    last_seen_at: null,
    direct_capable: false,
    ...partial,
  };
}

describe('findAdminNode', () => {
  test('a name in both rosters with the same id is fine', async () => {
    const cli = await ctx({
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE, hubNodeId: 'self' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
      'GET /api/hub/nodes': () => ({
        nodes: [hubRow({ id: NODE, name: 'office', admission_status: 'admitted' })],
      }),
    });
    const found = await findAdminNode(cli, 'office');
    expect(found.id).toBe(NODE);
    expect(found.mesh?.id).toBe(NODE);
    expect(found.hub?.id).toBe(NODE);
  });

  test('a name in both rosters with different ids asks for the 32-hex id', async () => {
    const cli = await ctx({
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE, hubNodeId: 'self' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
      'GET /api/hub/nodes': () => ({
        nodes: [hubRow({ id: HUB, name: 'office', admission_status: 'pending' })],
      }),
    });
    const error = await findAdminNode(cli, 'office').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).message).toContain(NODE);
    expect((error as UsageError).message).toContain(HUB);
    expect((error as UsageError).hint).toContain('32-hex');
  });

  test('a 32-hex id that exists in both rosters is not ambiguous', async () => {
    const cli = await ctx({
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE, hubNodeId: 'self' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
      'GET /api/hub/nodes': () => ({
        nodes: [hubRow({ id: NODE, name: 'desk', admission_status: 'admitted' })],
      }),
    });
    const found = await findAdminNode(cli, NODE);
    expect(found.id).toBe(NODE);
    expect(found.mesh?.name).toBe('office');
    expect(found.hub?.name).toBe('desk');
  });

  test('unknown name is not found', async () => {
    const cli = await ctx({
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE, hubNodeId: 'self' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      'GET /api/hub/nodes': () => ({ nodes: [] }),
    });
    await expect(findAdminNode(cli, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
