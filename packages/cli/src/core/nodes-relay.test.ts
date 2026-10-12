import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  deriveSeed,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { decodeRelayJoinToken } from '@vibeterm/shared/relay';
import { NODE, meshNode, routeFetch, testContext } from '../commands/cli-test-harness';
import { command as nodes } from '../commands/nodes';
import type { AuthMode } from './auth';
import { CliError, UsageError } from './errors';
import {
  appendRelayMetaKeyWithRoot,
  attachedRelayUrl,
  isRelayUplink,
  relayJoinTarget,
} from './nodes-relay';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const PEER = 'b'.repeat(32);
const TENANT_SH = 'a1'.repeat(16);
const TENANT_JP = 'b2'.repeat(16);
const HASH = encodeBase64url(new Uint8Array(32).fill(1));
const PAYLOAD = encodeBase64url(new Uint8Array([7, 8, 9]));
const KEY32 = encodeBase64url(new Uint8Array(32).fill(3));
const TOKEN32 = encodeBase64url(new Uint8Array(32).fill(4));
const SELF_SIGNED_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBiTCCAS+gAwIBAgIUfcjUcjvqps+j66WfMK5nTB66IH0wCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHVGVzdCBDQTAeFw0yNjA5MDExMjQyMjVaFw0yNzA5MDExMjQy
MjVaMBIxEDAOBgNVBAMMB1Rlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARW79kGjEFW4+Ueb2FviAO2IBOJdD2lWN6VopKfvyneN4Lut5OF/fMlSx5kKT9f
95QVrN1GPSkKnj52IdkENXPmo2MwYTAdBgNVHQ4EFgQU2KZVtCMikJHT2kNkteml
Z5MJzTAwHwYDVR0jBBgwFoAU2KZVtCMikJHT2kNktemlZ5MJzTAwDwYDVR0TAQH/
BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAJD13Sun
1WG27lzbwfxd5b6+xw+yDPORYStFfSEmgr6gAiAdpUqdYmGGVAEZXKxNP7FnGg6J
2fAjmnqZT1C+bcCDYg==
-----END CERTIFICATE-----`;
const SELF_SIGNED_CA_FP = '0f47afc79f7ccd374c52146fc47c9e30896b899a119966fcefc3c912014c76bd';

function rootAndMode(): { root: ReturnType<typeof rootKeyFromSeed>; mode: AuthMode } {
  const root = rootKeyFromSeed(new Uint8Array(32).fill(9));
  return {
    root,
    mode: {
      mode: 'mesh',
      nodeId: NODE,
      uid: 'u-1',
      username: 'admin',
      kdfParams: null,
      passkeysForThisOrigin: false,
      passkeyAvailable: true,
      rootEpoch: 0,
      rootPublicKey: encodeBase64url(root.publicKey),
    },
  };
}

async function ctx(
  routes: Parameters<typeof routeFetch>[0],
  json = true
): Promise<Awaited<ReturnType<typeof testContext>>> {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

describe('relay status helpers', () => {
  test('isRelayUplink only matches mode=relay', () => {
    expect(isRelayUplink(null)).toBe(false);
    expect(isRelayUplink({ mode: 'none' })).toBe(false);
    expect(isRelayUplink({ mode: 'relay' })).toBe(true);
  });

  test('attachedRelayUrl prefers the attached row', () => {
    expect(
      attachedRelayUrl({
        relays: [{ url: 'https://a.example' }, { url: 'https://b.example', attached: true }],
      })
    ).toBe('https://b.example');
  });

  test('relayJoinTarget pairs the primary relay url with its own tenant', () => {
    expect(
      relayJoinTarget({
        tenantId: TENANT_SH,
        relays: [
          { url: 'https://sh.example', tenantId: TENANT_SH, priority: 0, role: 'secondary' },
          {
            url: 'https://jp.example',
            tenantId: TENANT_JP,
            priority: 1,
            attached: true,
            role: 'primary',
          },
        ],
      })
    ).toEqual({ url: 'https://jp.example', tenantId: TENANT_JP });
  });

  test('relayJoinTarget on a legacy gateway falls back to the lowest-priority row', () => {
    expect(
      relayJoinTarget({
        tenantId: TENANT_SH,
        relays: [
          { url: 'https://sh.example', priority: 0 },
          { url: 'https://jp.example', priority: 1, attached: true },
        ],
      })
    ).toEqual({ url: 'https://sh.example', tenantId: TENANT_SH });
    expect(relayJoinTarget(null)).toBeNull();
  });
});

describe('appendRelayMetaKeyWithRoot', () => {
  test('prepare → head → signed meta-key append, JSON fields from prepare+seq', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const { root, mode } = rootAndMode();
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/meta-key/prepare': (_url, init) => {
        calls.push({
          method: 'POST',
          path: '/api/mesh/relay/meta-key/prepare',
          body: JSON.parse(String(init?.body)),
        });
        return { payload: PAYLOAD, payloadHash: 'h', epoch: 4 };
      },
      'GET /api/auth/keylog/head': () => {
        calls.push({ method: 'GET', path: '/api/auth/keylog/head', body: null });
        return { seq: 11, hash: HASH };
      },
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string; sig: string };
        calls.push({ method: 'POST', path: '/api/auth/keylog', body });
        return { ok: true, hubAck: true, relayAck: true, seq: 12 };
      },
    });
    const result = await appendRelayMetaKeyWithRoot(cli, root, mode, {
      op: 'admit',
      node_id: PEER,
    });
    expect(result).toEqual({ op: 'admit', epoch: 4, seq: 12 });
    expect(calls.map((row) => `${row.method} ${row.path}`)).toEqual([
      'POST /api/mesh/relay/meta-key/prepare',
      'GET /api/auth/keylog/head',
      'POST /api/auth/keylog',
    ]);
    expect(calls[0].body).toEqual({ op: 'admit', node_id: PEER });
    const appended = calls[2].body as { bytes: string; sig: string };
    const record = decodeKeyLogRecord(decodeBase64url(appended.bytes));
    expect(record.type).toBe('meta-key');
    expect(record.payload).toEqual(decodeBase64url(PAYLOAD));
    expect(record.seq).toBe(12n);
    expect(appended.sig.length).toBeGreaterThan(0);
  });

  test('rotate sends exclude and fails when relayAck is false', async () => {
    const { root, mode } = rootAndMode();
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/meta-key/prepare': (_url, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ op: 'rotate', exclude: [PEER] });
        return { payload: PAYLOAD, epoch: 5 };
      },
      'GET /api/auth/keylog/head': () => ({ seq: 1, hash: HASH }),
      'POST /api/auth/keylog': () => ({
        ok: true,
        hubAck: true,
        relayAck: false,
        relayError: 'timeout',
      }),
    });
    await expect(
      appendRelayMetaKeyWithRoot(cli, root, mode, { op: 'rotate', exclude: [PEER] })
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe('vibeterm nodes meta-key / enroll / allow (relay)', () => {
  test('meta-key without op is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(nodes.run(cli, ['meta-key'])).rejects.toBeInstanceOf(UsageError);
  });

  test('meta-key admit without a node is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(nodes.run(cli, ['meta-key', 'admit'])).rejects.toBeInstanceOf(UsageError);
  });

  test('enroll on relay hits join-material + relay enrollments', async () => {
    const hits: string[] = [];
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => {
        hits.push('mode');
        return { mode: 'mesh', nodeId: NODE };
      },
      'GET /api/mesh/relay/status': () => {
        hits.push('status');
        return { mode: 'relay', relays: [{ url: 'https://relay.example', attached: true }] };
      },
      'GET /api/mesh/relay/join-material': () => {
        hits.push('join-material');
        return {
          logKey: KEY32,
          relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
        };
      },
      'POST /api/mesh/relay/enrollments': () => {
        hits.push('relay-enroll');
        return { id: 'e1', expiresAt: 1 };
      },
    });
    await expect(nodes.run(cli, ['enroll'])).rejects.toBeInstanceOf(CliError);
    expect(hits).toContain('status');
    expect(hits).toContain('join-material');
    expect(hits).not.toContain('relay-enroll');
  });

  test('enroll without a relay uplink is NODE_NOT_ON_RELAY', async () => {
    const hits: string[] = [];
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => {
        hits.push('status');
        return { mode: 'none' };
      },
      'GET /api/mesh/relay/join-material': () => {
        hits.push('join-material');
        return { logKey: KEY32, relays: [] };
      },
    });
    const error = (await nodes.run(cli, ['enroll']).catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('NODE_NOT_ON_RELAY');
    expect(hits).toContain('status');
    expect(hits).not.toContain('join-material');
  });

  test('enroll --password on relay uses the attached relay url', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        tenantId: 'ab'.repeat(16),
        relays: [{ url: 'https://relay-sh.example', attached: true }],
      }),
    });
    await nodes.run(cli, ['enroll', '--password']);
    const payload = JSON.parse(stdout.text()) as { joinCommand: string; publicUrl: string };
    expect(payload.publicUrl).toBe('https://relay-sh.example');
    expect(payload.joinCommand).toContain('vibeterm relay join');
    expect(payload.joinCommand).toContain('--tenant');
    expect(payload.joinCommand).toContain('--password');
    expect(payload.joinCommand).toContain('https://relay-sh.example');
  });

  test('enroll --password on a legacy gateway uses the lowest-priority row', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        tenantId: TENANT_SH,
        relays: [
          { url: 'https://relay-sh.example', priority: 0 },
          { url: 'https://relay-jp.example', priority: 1, attached: true },
        ],
      }),
    });
    await nodes.run(cli, ['enroll', '--password']);
    expect(JSON.parse(stdout.text()).joinCommand).toBe(
      `vibeterm relay join 'https://relay-sh.example' --tenant ${TENANT_SH} --password`
    );
  });

  test('allow on a relay pendingMemberId wraps K_meta instead of domain-access', async () => {
    const hits: string[] = [];
    process.env.VIBETERM_PASSWORD = 'x';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => {
        hits.push('status');
        return { mode: 'relay' };
      },
      'GET /api/mesh/nodes': () => ({
        nodes: [meshNode()],
        pendingMemberIds: [NODE],
      }),
      'GET /api/auth/mode': () => {
        hits.push('mode');
        return { mode: 'mesh', nodeId: NODE };
      },
      [`PATCH /n/${NODE}/api/system/domain-access`]: () => {
        hits.push('domain-access');
        return { allowed: true };
      },
    });
    await expect(nodes.run(cli, ['allow', 'office'])).rejects.toBeInstanceOf(CliError);
    expect(hits).toContain('status');
    expect(hits).toContain('mode');
    expect(hits).not.toContain('domain-access');
  });

  test('allow on a fully synced relay node still patches domain-access', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => ({ mode: 'relay' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode()], pendingMemberIds: [] }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`PATCH /n/${NODE}/api/system/domain-access`]: (_url, init) => {
        body = String(init?.body);
        return { allowed: true };
      },
    });
    await nodes.run(cli, ['allow', 'office']);
    expect(JSON.parse(body)).toEqual({ allowed: true });
  });
});

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

describe('signed relay commands', () => {
  test('meta-key admit prints { op, epoch, seq } and signs a meta-key record', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const appended: Array<{ bytes: string; sig: string }> = [];
    const prepareBody: unknown[] = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'POST /api/mesh/relay/meta-key/prepare': (_url, init) => {
        prepareBody.push(JSON.parse(String(init?.body)));
        return { payload: PAYLOAD, epoch: 3 };
      },
      'GET /api/auth/keylog/head': () => ({ seq: 20, hash: HASH }),
      'POST /api/auth/keylog': (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { bytes: string; sig: string };
        appended.push(body);
        return { ok: true, hubAck: true, relayAck: true, seq: 21 };
      },
    });
    await nodes.run(cli, ['meta-key', 'admit', PEER]);
    expect(JSON.parse(stdout.text())).toEqual({ op: 'admit', epoch: 3, seq: 21 });
    expect(prepareBody).toEqual([{ op: 'admit', node_id: PEER }]);
    expect(decodeKeyLogRecord(decodeBase64url(appended[0].bytes)).type).toBe('meta-key');
  });

  test('meta-key rotate --exclude sends hex ids', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    let prepare: unknown;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: PEER, name: 'wait-box' })] }),
      'POST /api/mesh/relay/meta-key/prepare': (_url, init) => {
        prepare = JSON.parse(String(init?.body));
        return { payload: PAYLOAD, epoch: 8 };
      },
      'GET /api/auth/keylog/head': () => ({ seq: 1, hash: HASH }),
      'POST /api/auth/keylog': () => ({ ok: true, hubAck: true, seq: 2 }),
    });
    await nodes.run(cli, ['meta-key', 'rotate', '--exclude', 'wait-box', '--exclude', NODE]);
    expect(prepare).toEqual({ op: 'rotate', exclude: [PEER, NODE] });
    expect(JSON.parse(stdout.text())).toEqual({ op: 'rotate', epoch: 8, seq: 2 });
  });

  test('enroll on relay prints an r3. join command', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const hits: string[] = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        relays: [{ url: 'https://relay.example', attached: true }],
      }),
      'GET /api/mesh/relay/join-material': () => ({
        logKey: KEY32,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
      'POST /api/mesh/relay/enrollments': (_url, init) => {
        hits.push('relay-enroll');
        const body = JSON.parse(String(init?.body)) as { enroll_pk: string };
        expect(body.enroll_pk).toBeTruthy();
        return {
          id: 'enroll-1',
          expiresAt: 1_700_000_000_000,
          relays: [
            { url: 'https://relay.example', tenantId: PEER, token: TOKEN32, accepted: true },
          ],
        };
      },
    });
    await nodes.run(cli, ['enroll', '--name', 'studio']);
    const payload = JSON.parse(stdout.text()) as {
      id: string;
      joinToken: string;
      joinCommand: string;
      publicUrl: string;
      caFingerprint: string | null;
    };
    expect(payload.id).toBe('enroll-1');
    expect(payload.joinToken.startsWith('r3.')).toBe(true);
    expect(payload.joinToken.split('.')).toHaveLength(2);
    expect(payload.caFingerprint).toBeNull();
    expect(decodeRelayJoinToken(payload.joinToken).caFingerprint).toBeUndefined();
    expect(payload.joinCommand).toBe(
      `vibeterm relay join 'https://relay.example' --token ${payload.joinToken} --name studio`
    );
    expect(payload.publicUrl).toBe('https://relay.example');
    expect(hits).toEqual(['relay-enroll']);
  });

  describe('enroll token puts the primary relay first', () => {
    const SH_URL = 'https://relay-sh.example';
    const JP_URL = 'https://relay-jp.example';
    const TK_URL = 'https://relay-tk.example';

    async function enrollWith(accepted: string[], legacyWire = false) {
      const signed = await signingMode();
      process.env.VIBETERM_PASSWORD = signed.password;
      const tenantOf = (url: string) => (url === JP_URL ? TENANT_JP : TENANT_SH);
      const { ctx: cli, stdout } = await ctx({
        'GET /api/auth/mode': () => signed.json,
        'GET /api/mesh/relay/status': () => ({
          mode: 'relay',
          tenantId: TENANT_JP,
          relays: [
            { url: SH_URL, tenantId: TENANT_SH, priority: 0, role: 'secondary' },
            { url: JP_URL, tenantId: TENANT_JP, priority: 1, attached: true, role: 'primary' },
            { url: TK_URL, tenantId: TENANT_SH, priority: 2, role: 'secondary' },
          ],
        }),
        'GET /api/mesh/relay/join-material': () => ({
          logKey: KEY32,
          relays: [SH_URL, JP_URL, TK_URL].map((url) => ({
            url,
            tenantId: tenantOf(url),
            token: TOKEN32,
          })),
        }),
        'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
        'POST /api/mesh/relay/enrollments': () => ({
          id: 'enroll-1',
          expiresAt: 1_700_000_000_000,
          relays: legacyWire
            ? accepted
            : accepted.map((url) => ({
                url,
                tenantId: tenantOf(url),
                token: TOKEN32,
                accepted: true,
              })),
        }),
        'GET /api/tls/ca.crt': () => new Response('no_ca', { status: 404 }),
      });
      await nodes.run(cli, ['enroll']);
      const payload = JSON.parse(stdout.text()) as { joinToken: string; joinCommand: string };
      return {
        payload,
        urls: decodeRelayJoinToken(payload.joinToken).relays.map((relay) => relay.url),
      };
    }

    test('primary accepted: it leads, the rest keep their order', async () => {
      const { payload, urls } = await enrollWith([SH_URL, JP_URL, TK_URL]);
      expect(urls).toEqual([JP_URL, SH_URL, TK_URL]);
      expect(payload.joinCommand).toContain(`vibeterm relay join '${JP_URL}' --token`);
    });

    test('primary not accepted: the first accepted relay leads', async () => {
      const { payload, urls } = await enrollWith([TK_URL, SH_URL]);
      expect(urls).toEqual([TK_URL, SH_URL]);
      expect(payload.joinCommand).toContain(`vibeterm relay join '${TK_URL}' --token`);
    });

    test('legacy gateway returning accepted urls as strings: primary still leads', async () => {
      const { payload, urls } = await enrollWith([SH_URL, JP_URL, TK_URL], true);
      expect(urls).toEqual([JP_URL, SH_URL, TK_URL]);
      expect(payload.joinCommand).toContain(`vibeterm relay join '${JP_URL}' --token`);
    });

    test('legacy gateway string urls without the primary: first accepted leads', async () => {
      const { urls } = await enrollWith([TK_URL, SH_URL], true);
      expect(urls).toEqual([TK_URL, SH_URL]);
    });
  });

  test('enroll on a self-signed relay appends the CA fingerprint suffix', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        relays: [{ url: 'https://relay.example', attached: true }],
      }),
      'GET /api/mesh/relay/join-material': () => ({
        logKey: KEY32,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
      'POST /api/mesh/relay/enrollments': () => ({
        id: 'enroll-1',
        expiresAt: 1_700_000_000_000,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32, accepted: true }],
      }),
      'GET /api/tls/ca.crt': () =>
        new Response(SELF_SIGNED_CA_PEM, {
          status: 200,
          headers: { 'content-type': 'application/x-x509-ca-cert' },
        }),
    });
    await nodes.run(cli, ['enroll']);
    const payload = JSON.parse(stdout.text()) as {
      joinToken: string;
      caFingerprint: string | null;
    };
    expect(payload.caFingerprint).toBe(SELF_SIGNED_CA_FP);
    expect(payload.joinToken.endsWith(`.${SELF_SIGNED_CA_FP}`)).toBe(true);
    expect(decodeRelayJoinToken(payload.joinToken).caFingerprint).toBe(SELF_SIGNED_CA_FP);
  });

  test('enroll on a Lets Encrypt relay omits the fingerprint suffix', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        relays: [{ url: 'https://relay.example', attached: true }],
      }),
      'GET /api/mesh/relay/join-material': () => ({
        logKey: KEY32,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
      'POST /api/mesh/relay/enrollments': () => ({
        id: 'enroll-1',
        expiresAt: 1_700_000_000_000,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32, accepted: true }],
      }),
      'GET /api/tls/ca.crt': () => new Response('no_ca', { status: 404 }),
    });
    await nodes.run(cli, ['enroll']);
    const payload = JSON.parse(stdout.text()) as {
      joinToken: string;
      caFingerprint: string | null;
    };
    expect(payload.caFingerprint).toBeNull();
    expect(payload.joinToken.split('.')).toHaveLength(2);
    expect(decodeRelayJoinToken(payload.joinToken).caFingerprint).toBeUndefined();
  });

  test('enroll uses relay status caFingerprint when join-material has none', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const fromStatus = 'cd'.repeat(32);
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        relays: [{ url: 'https://relay.example', attached: true, caFingerprint: fromStatus }],
      }),
      'GET /api/mesh/relay/join-material': () => ({
        logKey: KEY32,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
      'POST /api/mesh/relay/enrollments': () => ({
        id: 'enroll-1',
        expiresAt: 1,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32, accepted: true }],
      }),
      'GET /api/tls/ca.crt': () =>
        new Response(SELF_SIGNED_CA_PEM, {
          status: 200,
          headers: { 'content-type': 'application/x-x509-ca-cert' },
        }),
    });
    await nodes.run(cli, ['enroll']);
    const payload = JSON.parse(stdout.text()) as {
      joinToken: string;
      caFingerprint: string | null;
    };
    expect(payload.caFingerprint).toBe(fromStatus);
    expect(decodeRelayJoinToken(payload.joinToken).caFingerprint).toBe(fromStatus);
  });

  test('enroll prefers join-material caFingerprint over GET /api/tls/ca.crt', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const fromMaterial = 'ab'.repeat(32);
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/relay/status': () => ({ mode: 'relay' }),
      'GET /api/mesh/relay/join-material': () => ({
        logKey: KEY32,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32 }],
        caFingerprint: fromMaterial,
      }),
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH }),
      'POST /api/mesh/relay/enrollments': () => ({
        id: 'enroll-1',
        expiresAt: 1,
        relays: [{ url: 'https://relay.example', tenantId: PEER, token: TOKEN32, accepted: true }],
      }),
      'GET /api/tls/ca.crt': () =>
        new Response(SELF_SIGNED_CA_PEM, {
          status: 200,
          headers: { 'content-type': 'application/x-x509-ca-cert' },
        }),
    });
    await nodes.run(cli, ['enroll']);
    const payload = JSON.parse(stdout.text()) as {
      joinToken: string;
      caFingerprint: string | null;
    };
    expect(payload.caFingerprint).toBe(fromMaterial);
    expect(decodeRelayJoinToken(payload.joinToken).caFingerprint).toBe(fromMaterial);
  });

  test('meta-key rotate --exclude accepts a mesh roster name', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    let prepare: unknown;
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: PEER, name: 'wait-box' })] }),
      'POST /api/mesh/relay/meta-key/prepare': (_url, init) => {
        prepare = JSON.parse(String(init?.body));
        return { payload: PAYLOAD, epoch: 8 };
      },
      'GET /api/auth/keylog/head': () => ({ seq: 1, hash: HASH }),
      'POST /api/auth/keylog': () => ({ ok: true, seq: 2 }),
    });
    await nodes.run(cli, ['meta-key', 'rotate', '--exclude', 'wait-box']);
    expect(prepare).toEqual({ op: 'rotate', exclude: [PEER] });
    expect(JSON.parse(stdout.text())).toEqual({ op: 'rotate', epoch: 8, seq: 2 });
  });

  test('relay allow accepts a mesh roster name', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => ({ mode: 'relay' }),
      'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: NODE, name: 'office' })] }),
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      [`PATCH /n/${NODE}/api/system/domain-access`]: (_url, init) => {
        body = String(init?.body);
        return { allowed: true };
      },
    });
    await nodes.run(cli, ['allow', 'office']);
    expect(JSON.parse(body)).toEqual({ allowed: true });
  });
});
