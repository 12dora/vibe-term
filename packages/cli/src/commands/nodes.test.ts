import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { parseDurationMs } from '../core/cmd';
import { AuthError, CliError, UsageError } from '../core/errors';
import { NODE, meshNode, routeFetch, testContext } from './cli-test-harness';
import { command as nodes } from './nodes';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
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

  test('uninstall posts then signed-revokes (not DELETE operation)', async () => {
    const methods: string[] = [];
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      [`POST /api/mesh/nodes/${NODE}/uninstall`]: () => {
        methods.push('POST uninstall');
        return { ok: true };
      },
      'GET /api/auth/mode': () => {
        methods.push('GET mode');
        return { mode: 'mesh' };
      },
      [`DELETE /api/mesh/nodes/${NODE}/operation`]: () => {
        methods.push('DELETE operation');
        return { ok: true };
      },
    });
    await expect(nodes.run(cli, ['uninstall', 'office', '--yes'])).rejects.toBeInstanceOf(CliError);
    expect(methods).toContain('POST uninstall');
    expect(methods).toContain('GET mode');
    expect(methods).not.toContain('DELETE operation');
    delete process.env.VIBETERM_PASSWORD;
  });

  test('uninstall on the entry attaches the target node cookie', async () => {
    const peer = 'b'.repeat(32);
    let cookie = '';
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({
        nodes: [meshNode({ id: peer, name: 'hub-sh' })],
      }),
      [`POST /api/mesh/nodes/${peer}/uninstall`]: (_url, init) => {
        cookie = new Headers(init?.headers).get('cookie') ?? '';
        return { ok: true };
      },
      'GET /api/auth/mode': () => ({ mode: 'mesh' }),
    });
    cli.http.jar.set('self', 'sid-self', 0);
    cli.http.jar.set(peer, 'sid-peer', 0);
    await expect(nodes.run(cli, ['uninstall', 'hub-sh', '--yes'])).rejects.toBeInstanceOf(CliError);
    expect(cookie).toContain('vibeterm_s_self=sid-self');
    expect(cookie).toContain(`vibeterm_s_${peer}=sid-peer`);
    delete process.env.VIBETERM_PASSWORD;
  });

  test('revoke requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
    });
    const error = (await nodes.run(cli, ['revoke', 'office']).catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.hint).toContain('--yes');
  });

  test('ls merges pending hub rows', async () => {
    const pendingId = 'b'.repeat(32);
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ isHub: true })] }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE, hubNodeId: 'self' }),
      'GET /api/hub/nodes': () => ({
        nodes: [
          { id: NODE, name: 'office', admission_status: 'admitted', online: true },
          {
            id: pendingId,
            name: 'wait-box',
            admission_status: 'pending',
            online: false,
            version: null,
            direct_capable: false,
          },
        ],
      }),
    });
    await nodes.run(cli, ['ls']);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ id: string; status: string; name: string }>;
    };
    expect(payload.nodes).toHaveLength(2);
    expect(payload.nodes[0].status).toBe('admitted');
    expect(payload.nodes[1]).toMatchObject({ id: pendingId, name: 'wait-box', status: 'pending' });
  });

  test('allow looks up pending hub rows before mesh', async () => {
    const pendingId = 'b'.repeat(32);
    const methods: string[] = [];
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [] }),
      'GET /api/auth/mode': () => {
        methods.push('GET mode');
        return { mode: 'mesh', nodeId: NODE, hubNodeId: 'self' };
      },
      'GET /api/hub/nodes': () => {
        methods.push('GET hub');
        return {
          nodes: [
            {
              id: pendingId,
              name: 'wait-box',
              admission_status: 'pending',
              online: false,
              authorization: 'YQ',
              authorization_sig: 'YQ',
              certificate: 'YQ',
              cert_sig: 'YQ',
            },
          ],
        };
      },
      [`PATCH /n/${pendingId}/api/system/domain-access`]: () => {
        methods.push('PATCH domain-access');
        return { allowed: true };
      },
    });
    await expect(nodes.run(cli, ['allow', 'wait-box'])).rejects.toBeInstanceOf(CliError);
    expect(methods).toContain('GET hub');
    expect(methods).toContain('GET mode');
    expect(methods).not.toContain('PATCH domain-access');
    delete process.env.VIBETERM_PASSWORD;
  });

  test('upgrade --all waits, filters, maps unconfirmed, exits 1', async () => {
    const hubId = 'c'.repeat(32);
    const offlineId = 'd'.repeat(32);
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/upgrade/latest': () => ({
        latestVersion: '2.0.9',
        changelog: null,
        publishedAt: null,
      }),
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({ version: '2.0.8', online: true, loggedIn: true }),
          meshNode({
            id: hubId,
            name: 'hub',
            isHub: true,
            version: '2.0.8',
            online: true,
            loggedIn: true,
          }),
          meshNode({
            id: offlineId,
            name: 'off',
            version: '2.0.8',
            online: false,
            loggedIn: true,
          }),
        ],
      }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`POST /api/mesh/nodes/${NODE}/upgrade`]: () =>
        new Response(JSON.stringify({ code: 'NODE_UNREACHABLE' }), { status: 409 }),
      [`POST /api/mesh/nodes/${hubId}/upgrade`]: () =>
        new Response(JSON.stringify({ code: 'UPGRADE_ALREADY_LATEST' }), { status: 409 }),
    });
    const code = await nodes.run(cli, ['upgrade', '--all']);
    const payload = JSON.parse(stdout.text()) as {
      outcomes: Array<{ node: string; outcome: string }>;
    };
    expect(payload.outcomes.map((row) => row.node)).toEqual([hubId, NODE]);
    expect(payload.outcomes.find((row) => row.node === NODE)?.outcome).toBe('unconfirmed');
    expect(payload.outcomes.find((row) => row.node === hubId)?.outcome).toBe('alreadyLatest');
    expect(code).toBe(1);
  });

  test('upgrade --all includes jar-only logins even when roster.loggedIn is false', async () => {
    const peer = 'b'.repeat(32);
    let upgradeCookie = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/upgrade/latest': () => ({
        latestVersion: '2.0.9',
        changelog: null,
        publishedAt: null,
      }),
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({
            id: peer,
            name: 'hub-sh',
            version: '2.0.8',
            online: true,
            loggedIn: false,
          }),
        ],
      }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`POST /api/mesh/nodes/${peer}/upgrade`]: (_url, init) => {
        upgradeCookie = new Headers(init?.headers).get('cookie') ?? '';
        return new Response(JSON.stringify({ code: 'UPGRADE_ALREADY_LATEST' }), { status: 409 });
      },
    });
    cli.http.jar.set('self', 'sid-self', 0);
    cli.http.jar.set(peer, 'sid-peer', 0);
    const code = await nodes.run(cli, ['upgrade', '--all']);
    const payload = JSON.parse(stdout.text()) as {
      outcomes: Array<{ node: string; outcome: string }>;
    };
    expect(payload.outcomes).toEqual([
      expect.objectContaining({ node: peer, outcome: 'alreadyLatest' }),
    ]);
    expect(upgradeCookie).toContain('vibeterm_s_self=sid-self');
    expect(upgradeCookie).toContain(`vibeterm_s_${peer}=sid-peer`);
    expect(code).toBe(0);
  });

  test('upgrade NODE_LOGIN_REQUIRED prints login --node', async () => {
    const peer = 'b'.repeat(32);
    const { ctx: cli } = await ctx({
      'GET /api/mesh/upgrade/latest': () => ({
        latestVersion: '2.0.9',
        changelog: null,
        publishedAt: null,
      }),
      'GET /api/mesh/nodes': () => ({
        nodes: [meshNode({ id: peer, name: 'hub-sh', version: '2.0.8' })],
      }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`POST /api/mesh/nodes/${peer}/upgrade`]: () =>
        new Response(JSON.stringify({ code: 'NODE_LOGIN_REQUIRED', nodeId: peer }), {
          status: 401,
        }),
    });
    const error = (await nodes.run(cli, ['upgrade', 'hub-sh']).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toBe(`run: vibeterm login --node ${peer}`);
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
