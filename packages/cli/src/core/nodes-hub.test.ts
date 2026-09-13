import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { NODE, meshNode, routeFetch, testContext } from '../commands/cli-test-harness';
import { NotFoundError, UsageError } from './errors';
import {
  findAdminNode,
  formatRelativeLastSeen,
  listedOnline,
  nodeAddressOf,
  reachOf,
} from './nodes-hub';

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

describe('nodeAddressOf / reachOf / listedOnline', () => {
  function row(partial: Record<string, unknown> = {}): MeshNode & { status?: string } {
    return meshNode(partial) as MeshNode & { status?: string };
  }

  test('address 优先级与中转收成 relay', () => {
    const hubId = 'c'.repeat(32);
    expect(
      nodeAddressOf(
        row({ id: hubId, isHub: true, peerAddress: '10.0.0.1', transport: 'dc' }),
        new Map([[hubId, 'https://tokyo.example:8443']])
      )
    ).toBe('tokyo.example:8443');
    expect(nodeAddressOf(row({ transport: 'dc', peerAddress: '10.0.0.8' }))).toBe('10.0.0.8');
    expect(
      nodeAddressOf(
        row({
          transport: null,
          peerAddress: null,
          endpoints: ['ws://10.0.0.9:39001/peer', 'wss://edge.example:39001/peer'],
        })
      )
    ).toBe('edge.example:39001');
    expect(
      nodeAddressOf(row({ transport: 'relay', viaRelay: 'https://sh.example', reach: 'relay' }))
    ).toBe('sh.example');
    expect(nodeAddressOf({ ...row(), status: 'pending' })).toBe('-');
  });

  test('reachOf 对齐表：lan/dc、wan/ws-secure、relay；离线为 -', () => {
    expect(reachOf(row({ reach: 'lan', transport: 'dc' }))).toBe('lan/dc');
    expect(reachOf(row({ reach: 'wan', transport: 'ws-secure' }))).toBe('wan/ws-secure');
    expect(reachOf(row({ reach: 'relay', transport: 'relay' }))).toBe('relay');
    expect(reachOf(row({ online: false, reach: 'lan', transport: 'dc' }))).toBe('-');
  });

  test('listedOnline 离线拼相对时间', () => {
    const now = 1_700_000_000_000;
    expect(listedOnline(row({ online: true, loggedIn: true }), now)).toBe('yes · signed-in');
    expect(listedOnline(row({ online: true, loggedIn: false }), now)).toBe('yes · signed-out');
    expect(listedOnline(row({ online: false, lastSeenAt: now - 3 * 3600_000 }), now)).toBe(
      'no · 3h ago'
    );
    expect(listedOnline(row({ online: false, lastSeenAt: null }), now)).toBe('no');
    expect(formatRelativeLastSeen(now - 5000, now)).toBe('just now');
  });
});
