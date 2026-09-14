import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import type { MeshNode } from '@vibeterm/api-client/auth/types';
import { NODE, meshNode, routeFetch, testContext } from '../commands/cli-test-harness';
import { NotFoundError } from './errors';
import {
  findAdminNode,
  formatRelativeLastSeen,
  isTrustedPublicUrl,
  joinCommand,
  listedOnline,
  nodeAddressOf,
  passwordJoinCommand,
  reachOf,
} from './nodes-roster';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built.ctx;
}

describe('findAdminNode', () => {
  test('resolves a mesh roster name', async () => {
    const cli = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
    });
    const found = await findAdminNode(cli, 'office');
    expect(found.id).toBe(NODE);
    expect(found.mesh?.id).toBe(NODE);
  });

  test('resolves a 32-hex id', async () => {
    const cli = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
    });
    const found = await findAdminNode(cli, NODE);
    expect(found.id).toBe(NODE);
    expect(found.mesh?.name).toBe('office');
  });

  test('unknown name is not found', async () => {
    const cli = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
    });
    await expect(findAdminNode(cli, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('joinCommand / isTrustedPublicUrl', () => {
  test('prints vibeterm relay join with the flags relay join accepts', () => {
    expect(joinCommand('https://relay.example', 'r3.token', 'studio')).toBe(
      "vibeterm relay join 'https://relay.example' --token r3.token --name studio"
    );
    expect(passwordJoinCommand('https://relay.example', 'ab'.repeat(16))).toBe(
      `vibeterm relay join 'https://relay.example' --tenant ${'ab'.repeat(16)} --password`
    );
    expect(() => passwordJoinCommand('https://relay.example', '')).toThrow('tenant');
  });

  test('rejects non-https public urls except loopback', () => {
    expect(isTrustedPublicUrl('https://relay.example')).toBe(true);
    expect(isTrustedPublicUrl('http://127.0.0.1:9883')).toBe(true);
    expect(isTrustedPublicUrl('http://relay.example')).toBe(false);
    expect(() => joinCommand('http://relay.example', 'tok')).toThrow();
  });
});

describe('nodeAddressOf / reachOf / listedOnline', () => {
  function row(partial: Record<string, unknown> = {}): MeshNode & { status?: string } {
    return meshNode(partial) as MeshNode & { status?: string };
  }

  test('address 优先级与中转收成 relay', () => {
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
