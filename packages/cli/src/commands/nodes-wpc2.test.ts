import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  deriveSeed,
  encodeAuthorization,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { CliError, UsageError } from '../core/errors';
import { NODE, meshNode, routeFetch, testContext } from './cli-test-harness';
import { command as nodes } from './nodes';

const dirs: string[] = [];
const SPARE = 'b'.repeat(32);
const RELAY_URL = 'https://relay-2.example';
const HASH = encodeBase64url(new Uint8Array(32).fill(1));
const PAYLOAD = encodeBase64url(new Uint8Array([7, 8, 9]));

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0], json = true) {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

async function signingMode(password = 'pw') {
  const kdf = generateKdfParams();
  const seed = await deriveSeed(password, kdf);
  const root = rootKeyFromSeed(seed);
  return {
    password,
    json: {
      mode: 'mesh' as const,
      nodeId: NODE,
      uid: 'u-1',
      username: 'admin',
      kdfParams: {
        salt: encodeBase64url(kdf.salt),
        memory_kib: kdf.memory_kib,
        iterations: kdf.iterations,
        parallelism: kdf.parallelism,
      },
      passkeysForThisOrigin: false,
      passkeyAvailable: true,
      rootEpoch: 0,
      rootPublicKey: encodeBase64url(root.publicKey),
    },
  };
}

function hubRow(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: id,
    publicUrl: `https://${id.slice(0, 8)}.example`,
    mode: extra.mode ?? 'standby',
    priority: extra.priority ?? 1,
    writerEpoch: extra.writerEpoch ?? 0,
    online: extra.online ?? true,
    authorization: extra.authorization ?? 'signed',
    ...extra,
  };
}

const SAMPLE_PORT = {
  purpose: 'peer-signaling',
  proto: 'tcp' as const,
  port: 39001,
  status: 'open' as const,
  code: undefined,
  checkedAt: 1_700_000_000_000,
};

describe('vibeterm nodes ports / show ports', () => {
  test('ports prints MeshNode.ports without probing', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ ports: [SAMPLE_PORT] })] }),
    });
    await nodes.run(cli, ['ports', 'office']);
    expect(JSON.parse(stdout.text())).toEqual({ node: NODE, ports: [SAMPLE_PORT] });
  });

  test('ports --probe POSTs then prints the probe result', async () => {
    const probed = [{ ...SAMPLE_PORT, status: 'blocked', code: 'peer_refused' }];
    let posted = false;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ ports: [SAMPLE_PORT] })] }),
      [`POST /api/mesh/nodes/${NODE}/ports/probe`]: () => {
        posted = true;
        return { ports: probed };
      },
    });
    await nodes.run(cli, ['ports', 'office', '--probe']);
    expect(posted).toBe(true);
    expect(JSON.parse(stdout.text()).ports).toEqual(probed);
  });

  test('show includes a ports summary in human output', async () => {
    const { ctx: cli, stdout } = await ctx(
      {
        'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ ports: [SAMPLE_PORT] })] }),
      },
      false
    );
    await nodes.run(cli, ['show', 'office']);
    const text = stdout.text();
    expect(text).toContain('PURPOSE');
    expect(text).toContain('peer-signaling');
    expect(text).toContain('39001');
  });
});

describe('vibeterm nodes upgrade cancel / --ids / op clear', () => {
  test('upgrade cancel DELETEs …/upgrade', async () => {
    let deleted = false;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      [`DELETE /api/mesh/nodes/${NODE}/upgrade`]: () => {
        deleted = true;
        return { ok: true };
      },
    });
    await nodes.run(cli, ['upgrade', 'cancel', 'office', '--yes']);
    expect(deleted).toBe(true);
    expect(JSON.parse(stdout.text())).toEqual({ node: NODE, cancelled: true });
  });

  test('upgrade --ids filters like --all and implies wait', async () => {
    const peer = SPARE;
    const posted: string[] = [];
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
            id: peer,
            name: 'spare',
            version: '2.0.8',
            online: false,
            loggedIn: true,
          }),
        ],
      }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`POST /api/mesh/nodes/${NODE}/upgrade`]: () => {
        posted.push(NODE);
        return new Response(JSON.stringify({ code: 'UPGRADE_ALREADY_LATEST' }), { status: 409 });
      },
      [`POST /api/mesh/nodes/${peer}/upgrade`]: () => {
        posted.push(peer);
        return { state: 'downloading' };
      },
    });
    const code = await nodes.run(cli, ['upgrade', '--ids', `office,${peer}`]);
    expect(posted).toEqual([NODE]);
    const payload = JSON.parse(stdout.text()) as { outcomes: Array<{ node: string }> };
    expect(payload.outcomes.map((row) => row.node)).toEqual([NODE]);
    expect(code).toBe(0);
  });

  test('upgrade --all and --ids together is usage', async () => {
    const { ctx: cli } = await ctx({});
    await expect(nodes.run(cli, ['upgrade', '--all', '--ids', NODE])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('op clear DELETEs …/operation', async () => {
    let deleted = false;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      [`DELETE /api/mesh/nodes/${NODE}/operation`]: () => {
        deleted = true;
        return { ok: true };
      },
    });
    await nodes.run(cli, ['op', 'clear', 'office']);
    expect(deleted).toBe(true);
    expect(JSON.parse(stdout.text())).toEqual({ ok: true });
  });
});

describe('vibeterm nodes hub-role', () => {
  test('promote POSTs standby on the writer then active on the target', async () => {
    const bodies: Array<{ path: string; body: unknown }> = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({ isHub: true, hubMode: 'active' }),
          meshNode({ id: SPARE, name: 'spare', isHub: true, hubMode: 'standby' }),
        ],
      }),
      'GET /api/mesh/hubs': () => ({
        writerHubId: NODE,
        attached: null,
        candidates: [],
        hubs: [
          hubRow(NODE, { mode: 'active', priority: 0, writerEpoch: 2 }),
          hubRow(SPARE, { mode: 'standby', priority: 1, writerEpoch: 0 }),
        ],
      }),
      [`POST /n/${NODE}/api/hub/role`]: (_url, init) => {
        bodies.push({ path: 'writer', body: JSON.parse(String(init?.body)) });
        return { phase: 'accepted', operationId: 'op', mode: 'standby' };
      },
      [`POST /n/${SPARE}/api/hub/role`]: (_url, init) => {
        bodies.push({ path: 'target', body: JSON.parse(String(init?.body)) });
        return { phase: 'accepted', operationId: 'op', mode: 'active' };
      },
    });
    await nodes.run(cli, ['hub-role', 'promote', 'spare', '--yes']);
    expect(bodies.map((row) => row.path)).toEqual(['writer', 'target']);
    expect(bodies[0].body).toMatchObject({ mode: 'standby' });
    expect(bodies[1].body).toMatchObject({ mode: 'active' });
    expect(JSON.parse(stdout.text()).kind).toBe('done');
  });

  test('standby POSTs mode=standby to the named hub', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ isHub: true, hubMode: 'active' })] }),
      'GET /api/mesh/hubs': () => ({
        writerHubId: NODE,
        attached: null,
        candidates: [],
        hubs: [hubRow(NODE, { mode: 'active', priority: 0, writerEpoch: 1 })],
      }),
      [`POST /n/${NODE}/api/hub/role`]: (_url, init) => {
        body = String(init?.body);
        return { phase: 'accepted', mode: 'standby' };
      },
    });
    await nodes.run(cli, ['hub-role', 'standby', 'office', '--yes']);
    expect(JSON.parse(body).mode).toBe('standby');
  });

  test('promote --wait polls role/status then writerHubId', async () => {
    let promoted = false;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({ isHub: true, hubMode: 'active' }),
          meshNode({ id: SPARE, name: 'spare', isHub: true, hubMode: 'standby' }),
        ],
      }),
      'GET /api/mesh/hubs': () => ({
        writerHubId: promoted ? SPARE : NODE,
        attached: null,
        candidates: [],
        hubs: [
          hubRow(NODE, { mode: promoted ? 'standby' : 'active', priority: 0, writerEpoch: 2 }),
          hubRow(SPARE, {
            mode: promoted ? 'active' : 'standby',
            priority: 1,
            writerEpoch: promoted ? 3 : 0,
          }),
        ],
      }),
      [`POST /n/${NODE}/api/hub/role`]: () => ({ phase: 'accepted', mode: 'standby' }),
      [`POST /n/${SPARE}/api/hub/role`]: () => {
        promoted = true;
        return { phase: 'accepted', mode: 'active' };
      },
      [`GET /n/${SPARE}/api/hub/role/status`]: () => ({ phase: 'complete', mode: 'active' }),
    });
    await nodes.run(cli, ['hub-role', 'promote', 'spare', '--yes', '--wait']);
    expect(JSON.parse(stdout.text())).toMatchObject({ kind: 'done', writerHubId: SPARE });
  });

  test('promote of an unsigned hub signs admit-hub first', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    let admitted = false;
    const types: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({ isHub: true, hubMode: 'active' }),
          meshNode({ id: SPARE, name: 'spare', isHub: true, hubMode: 'standby' }),
        ],
      }),
      'GET /api/mesh/hubs': () => ({
        writerHubId: NODE,
        attached: null,
        candidates: [],
        hubs: [
          hubRow(NODE, { mode: 'active', priority: 0, writerEpoch: 2 }),
          hubRow(SPARE, {
            mode: 'standby',
            priority: 1,
            writerEpoch: 0,
            authorization: admitted ? 'signed' : 'env',
          }),
        ],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 3, hash: HASH }),
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string };
        types.push(decodeKeyLogRecord(decodeBase64url(body.bytes)).type);
        admitted = true;
        return { ok: true, hubAck: true, seq: 4 };
      },
      [`POST /n/${NODE}/api/hub/role`]: () => ({ phase: 'accepted', mode: 'standby' }),
      [`POST /n/${SPARE}/api/hub/role`]: () => ({ phase: 'accepted', mode: 'active' }),
    });
    await nodes.run(cli, ['hub-role', 'promote', 'spare', '--yes']);
    expect(types).toEqual(['admit-hub']);
    expect(admitted).toBe(true);
  });

  test('hub-role without --yes is a usage error off-tty', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ isHub: true })] }),
      'GET /api/mesh/hubs': () => ({
        writerHubId: NODE,
        attached: null,
        candidates: [],
        hubs: [hubRow(NODE)],
      }),
    });
    await expect(nodes.run(cli, ['hub-role', 'standby', 'office'])).rejects.toBeInstanceOf(
      UsageError
    );
  });
});

describe('vibeterm nodes relay', () => {
  test('relay ls hits GET /api/mesh/relay/status', async () => {
    const status = {
      mode: 'relay',
      relays: [
        {
          url: RELAY_URL,
          priority: 0,
          online: true,
          attached: true,
          role: 'primary',
          rttMs: 18,
        },
      ],
    };
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => status,
    });
    await nodes.run(cli, ['relay', 'ls']);
    expect(JSON.parse(stdout.text())).toEqual(status);
  });

  test('relay switch POSTs /api/mesh/relay/switch', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/switch': (_url, init) => {
        body = String(init?.body);
        return { mode: 'relay', relays: [{ url: RELAY_URL, attached: true }] };
      },
    });
    await nodes.run(cli, ['relay', 'switch', RELAY_URL]);
    expect(JSON.parse(body)).toEqual({ url: RELAY_URL });
  });

  test('relay rm prepare + signed set-relays', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const types: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'POST /api/mesh/relay/remove/prepare': (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ url: RELAY_URL });
        return { payload: PAYLOAD, payloadHash: 'h' };
      },
      'GET /api/auth/keylog/head': () => ({ seq: 8, hash: HASH }),
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string };
        types.push(decodeKeyLogRecord(decodeBase64url(body.bytes)).type);
        return { ok: true, hubAck: true, relayAck: true, seq: 9 };
      },
    });
    await nodes.run(cli, ['relay', 'rm', RELAY_URL, '--yes']);
    expect(types).toEqual(['set-relays']);
  });

  test('relay rm of the last relay is RELAY_LAST', async () => {
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/remove/prepare': () =>
        new Response(JSON.stringify({ code: 'RELAY_LAST' }), { status: 409 }),
    });
    const error = (await nodes
      .run(cli, ['relay', 'rm', RELAY_URL, '--yes'])
      .catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toContain('last relay');
  });

  test('relay readmit with an empty prepare is a no-op', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/readmit/prepare': () => ({ rootEpoch: 1, entries: [] }),
    });
    await nodes.run(cli, ['relay', 'readmit', '--yes']);
    expect(JSON.parse(stdout.text())).toMatchObject({ signed: 0, total: 0 });
  });

  test('relay readmit signs readmit-node for each entry', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const authorization = encodeBase64url(
      encodeAuthorization({
        domain: 'tmex/enroll/v1',
        uid: 'u-1',
        enroll_pk: new Uint8Array(32).fill(2),
        exp: 99n,
        root_epoch: 0,
        signer: 'root',
        credential_id: null,
      })
    );
    const types: string[] = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/readmit/prepare': () => ({
        rootEpoch: 0,
        entries: [
          {
            nodeId: SPARE,
            name: 'spare',
            authorization_bytes: authorization,
            certificate_bytes: encodeBase64url(new Uint8Array([1, 2, 3])),
            cert_sig: encodeBase64url(new Uint8Array(64).fill(4)),
          },
        ],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 1, hash: HASH }),
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string };
        types.push(decodeKeyLogRecord(decodeBase64url(body.bytes)).type);
        return { ok: true, hubAck: true, relayAck: true, seq: 2 };
      },
    });
    await nodes.run(cli, ['relay', 'readmit', '--yes']);
    expect(types).toEqual(['readmit-node']);
    expect(JSON.parse(stdout.text()).signed).toBe(1);
  });
});

describe('vibeterm nodes rename in relay mode', () => {
  test('rename on a relay uplink signs rename-node instead of hub REST', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const hits: string[] = [];
    const types: string[] = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()] }),
      'GET /api/mesh/relay/status': () => {
        hits.push('status');
        return { mode: 'relay', relays: [{ url: RELAY_URL, attached: true }] };
      },
      'GET /api/auth/mode': () => signed.json,
      'GET /api/auth/keylog/head': () => ({ seq: 5, hash: HASH }),
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string };
        types.push(decodeKeyLogRecord(decodeBase64url(body.bytes)).type);
        return { ok: true, hubAck: true, seq: 6 };
      },
      [`POST /n/${NODE}/api/hub/nodes/${NODE}/rename`]: () => {
        hits.push('hub-rename');
        return { ok: true };
      },
    });
    await nodes.run(cli, ['rename', 'office', 'desk']);
    expect(hits).toContain('status');
    expect(hits).not.toContain('hub-rename');
    expect(types).toEqual(['rename-node']);
    expect(JSON.parse(stdout.text())).toMatchObject({ ok: true, id: NODE, name: 'desk' });
  });

  test('rename on hub still POSTs the hub control plane', async () => {
    const seen: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ isHub: true, hubMode: 'active' })] }),
      'GET /api/mesh/relay/status': () => ({ mode: 'hub' }),
      [`POST /n/${NODE}/api/hub/nodes/${NODE}/rename`]: (_url, init) => {
        seen.push(String(init?.body));
        return { ok: true, id: NODE, name: 'desk' };
      },
    });
    await nodes.run(cli, ['rename', 'office', 'desk']);
    expect(seen[0]).toContain('desk');
  });
});
