import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { parseDurationMs } from '../core/cmd';
import { UsageError } from '../core/errors';
import { NODE, meshNode, routeFetch, testContext } from './cli-test-harness';
import { command as nodes } from './nodes';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0], json = true) {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

describe('parseDurationMs', () => {
  test('parses m/s/h', () => {
    expect(parseDurationMs('10m')).toBe(600_000);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('1h')).toBe(3_600_000);
  });
});

describe('vibeterm nodes', () => {
  test('ls treats missing mesh roster as empty', async () => {
    const { ctx: cli, stdout } = await ctx({});
    await nodes.run(cli, ['ls']);
    expect(JSON.parse(stdout.text())).toEqual({ nodes: [] });
  });

  test('ls prints the mesh roster', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
    });
    await nodes.run(cli, ['ls']);
    const payload = JSON.parse(stdout.text()) as { nodes: Array<{ id: string }> };
    expect(payload.nodes[0].id).toBe(NODE);
  });

  test('show returns the full row', async () => {
    const row = meshNode({
      directFailure: { at: 1, ws: 'timeout' },
      dcBreaker: { cooling: false, until: null, failures: 0, level: 0, lastFailureKind: null },
      endpoints: ['ws://10.0.0.2:39001/peer'],
    });
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [row] }),
    });
    await nodes.run(cli, ['show', 'office']);
    expect(JSON.parse(stdout.text()).endpoints).toEqual(['ws://10.0.0.2:39001/peer']);
  });

  test('hubs hits /api/mesh/hubs', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/hubs': () => ({
        hubs: [{ nodeId: NODE, publicUrl: 'https://hub.example', mode: 'active' }],
        attached: null,
        writerHubId: NODE,
        candidates: [],
      }),
    });
    await nodes.run(cli, ['hubs']);
    expect(JSON.parse(stdout.text()).writerHubId).toBe(NODE);
  });

  test('rename posts to the hub node', async () => {
    const seen: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({
        nodes: [meshNode({ isHub: true, hubMode: 'active' })],
      }),
      [`POST /n/${NODE}/api/hub/nodes/${NODE}/rename`]: (_url, init) => {
        seen.push(String(init?.body));
        return { ok: true, id: NODE, name: 'desk' };
      },
    });
    await nodes.run(cli, ['rename', 'office', 'desk']);
    expect(seen[0]).toContain('desk');
  });

  test('disallow patches domain-access', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      [`PATCH /n/${NODE}/api/system/domain-access`]: (_url, init) => {
        body = String(init?.body);
        return { allowed: false, viaDomain: false, hosts: [] };
      },
    });
    await nodes.run(cli, ['disallow', 'office']);
    expect(JSON.parse(body)).toEqual({ allowed: false });
  });

  test('uninstall requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
    });
    const error = (await nodes.run(cli, ['uninstall', 'office']).catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.hint).toContain('--yes');
  });

  test('uninstall posts then deletes the operation', async () => {
    const methods: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      [`POST /api/mesh/nodes/${NODE}/uninstall`]: () => {
        methods.push('POST');
        return { ok: true };
      },
      [`DELETE /api/mesh/nodes/${NODE}/operation`]: () => {
        methods.push('DELETE');
        return { ok: true };
      },
    });
    await nodes.run(cli, ['uninstall', 'office', '--yes']);
    expect(methods).toEqual(['POST', 'DELETE']);
  });

  test('upgrade without --wait POSTs once', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/upgrade/latest': () => ({
        latestVersion: '2.0.9',
        changelog: null,
        publishedAt: null,
      }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ version: '2.0.8' })] }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`POST /api/mesh/nodes/${NODE}/upgrade`]: () => ({ state: 'downloading' }),
    });
    await nodes.run(cli, ['upgrade', 'office']);
    expect(JSON.parse(stdout.text()).outcomes[0].outcome).toBe('done');
  });

  test('rtc-config includes probes', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/rtc-config': () => ({ stun: [], turn: null, probes: [{ url: 'stun:x' }] }),
    });
    await nodes.run(cli, ['rtc-config']);
    expect(JSON.parse(stdout.text()).probes).toHaveLength(1);
  });

  test('enroll --password prints a join command', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => ({
        mode: 'mesh',
        nodeId: NODE,
        hubPublicUrl: 'https://hub.example',
      }),
    });
    await nodes.run(cli, ['enroll', '--password']);
    expect(JSON.parse(stdout.text()).joinCommand).toContain('vibeterm hub join');
    expect(JSON.parse(stdout.text()).joinCommand).toContain('--password');
  });

  test('missing subcommand is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(nodes.run(cli, [])).rejects.toBeInstanceOf(UsageError);
  });
});
