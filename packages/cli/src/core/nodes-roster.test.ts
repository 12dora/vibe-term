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
  lastSeenOf,
  loginStateOf,
  nodeAddressOf,
  nodeStateOf,
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

  test('nodeStateOf / lastSeenOf：在线 now，离线相对时间，未知 -，pending -', () => {
    const now = 1_700_000_000_000;
    expect(nodeStateOf(row({ online: true }))).toBe('online');
    expect(nodeStateOf(row({ online: false }))).toBe('offline');
    expect(nodeStateOf({ ...row(), status: 'pending' })).toBe('pending');
    expect(lastSeenOf(row({ online: true, lastSeenAt: null }), now)).toBe('now');
    expect(lastSeenOf(row({ online: false, lastSeenAt: now - 3 * 3600_000 }), now)).toBe('3h ago');
    expect(lastSeenOf(row({ online: false, lastSeenAt: now - 5 * 60_000 }), now)).toBe('5m ago');
    expect(lastSeenOf(row({ online: false, lastSeenAt: now - 2 * 86_400_000 }), now)).toBe(
      '2d ago'
    );
    expect(lastSeenOf(row({ online: false, lastSeenAt: null }), now)).toBe('-');
    const pending = { ...row({ online: false, lastSeenAt: now - 1000 }), status: 'pending' };
    expect(lastSeenOf(pending, now)).toBe('-');
    expect(formatRelativeLastSeen(now - 5000, now)).toBe('just now');
  });

  test('loginStateOf 只看本地 jar：有效会话 session，过期 / 缺失 -，本机用 self 键', async () => {
    const cli = await ctx({});
    const now = 1_700_000_000_000;
    const peer = 'b'.repeat(32);
    expect(loginStateOf(cli, peer, null, now)).toBe('-');
    cli.http.jar.set(peer, 'sid', now + 1000);
    expect(loginStateOf(cli, peer, null, now)).toBe('session');
    cli.http.jar.set(peer, 'sid', now - 1);
    expect(loginStateOf(cli, peer, null, now)).toBe('-');
    cli.http.jar.set('self', 'sid-self', 0);
    expect(loginStateOf(cli, NODE, NODE, now)).toBe('session');
    expect(loginStateOf(cli, NODE, null, now)).toBe('-');
  });

  test('loginStateOf：无会话但有有效令牌为 token，会话优先，过期令牌为 -', async () => {
    const cli = await ctx({});
    const entry = cli.globals.entry;
    const now = 1_700_000_000_000;
    const peer = 'b'.repeat(32);
    const stored = (expiresAt: number | null) => ({
      tokenId: 't',
      secret: 'vtk_x',
      name: 'ci',
      scopes: ['exec'],
      expiresAt,
      createdAt: 1,
    });
    cli.tokens.put(entry, [peer], stored(now + 1000));
    expect(loginStateOf(cli, peer, null, now)).toBe('token');
    cli.http.jar.set(peer, 'sid', now + 1000);
    expect(loginStateOf(cli, peer, null, now)).toBe('session');
    cli.http.jar.clear(peer);
    cli.tokens.put(entry, [peer], stored(now - 1));
    expect(loginStateOf(cli, peer, null, now)).toBe('-');
    cli.tokens.put(entry, ['self'], stored(null));
    expect(loginStateOf(cli, NODE, NODE, now)).toBe('token');
    expect(loginStateOf(cli, NODE, null, now)).toBe('-');
  });
});
