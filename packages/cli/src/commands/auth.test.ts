import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeLoginPolicyPayload,
  deriveSeed,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { EXIT_NETWORK, UsageError } from '../core/errors';
import { command as auth } from './auth';
import { NODE, jsonResponse, meshNode, routeFetch, testContext } from './cli-test-harness';

const OTHER = 'b'.repeat(32);
const OLD = 'c'.repeat(32);
const DOWN = 'd'.repeat(32);
const AT = 1_700_000_000_000;

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function roster() {
  return {
    nodes: [
      meshNode({ id: NODE, name: 'office', version: '2.10.0', online: true }),
      meshNode({ id: OTHER, name: 'jp', version: '2.10.0', online: true }),
      meshNode({ id: OLD, name: 'legacy', version: '2.9.1', online: true }),
      meshNode({ id: DOWN, name: 'down', version: '2.10.0', online: false }),
    ],
  };
}

function record(partial: Record<string, unknown>) {
  return {
    at: AT,
    outcome: 'success',
    method: 'root',
    second: 'totp',
    client: 'cli',
    kind: 'interactive',
    viaNodeId: null,
    ip: '203.0.113.8',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    code: null,
    ...partial,
  };
}

async function ctx(
  routes: Parameters<typeof routeFetch>[0],
  options: { json?: boolean; node?: string } = {}
) {
  const built = await testContext(
    routeFetch({
      'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
      'GET /api/mesh/nodes': () => roster(),
      ...routes,
    }),
    options
  );
  dirs.push(built.dir);
  return built;
}

describe('vibeterm auth history', () => {
  test('fans out, skips old and offline nodes, and prints background entry', async () => {
    const paths: string[] = [];
    const {
      ctx: cli,
      stdout,
      stderr,
    } = await ctx({
      'GET /api/auth/login-records': (url) => {
        paths.push(`${url.pathname}${url.search}`);
        return {
          records: [record({ client: 'cli', kind: 'interactive' })],
        };
      },
      [`GET /n/${OTHER}/api/auth/login-records`]: (url) => {
        paths.push(`${url.pathname}${url.search}`);
        return {
          records: [
            record({
              client: 'web',
              kind: 'background',
              viaNodeId: NODE,
              at: AT - 1000,
            }),
          ],
        };
      },
    });
    const code = await auth.run(cli, ['history', '--all']);
    expect(code).toBe(0);
    expect(
      paths.every((path) => path.includes('outcome=success') && path.includes('kind=all'))
    ).toBe(true);
    const text = stdout.text();
    expect(text).toContain('TIME');
    expect(text).toContain('password+totp');
    expect(text).toContain('cli');
    expect(text).toContain('Chrome / macOS');
    expect(text).toContain('office');
    expect(stderr.text()).toContain('skipped legacy:');
    expect(stderr.text()).toContain('skipped down: offline');
    expect(text).toContain('office');
  });

  test('405 from an unversioned node is a 2.10.0 skip', async () => {
    const mystery = 'e'.repeat(32);
    const { ctx: cli, stderr } = await ctx({
      'GET /api/mesh/nodes': () => ({
        nodes: [
          meshNode({ id: NODE, name: 'office', version: '2.10.0', online: true }),
          meshNode({ id: mystery, name: 'mystery', version: null, online: true }),
        ],
      }),
      'GET /api/auth/login-records': () => ({ records: [] }),
      [`GET /n/${mystery}/api/auth/login-records`]: () =>
        jsonResponse({ code: 'method_not_allowed' }, 405),
    });
    expect(await auth.run(cli, ['history'])).toBe(0);
    expect(stderr.text()).toContain('needs upgrade to 2.10.0');
    expect(stderr.text()).toContain('mystery');
  });

  test('--failed asks for failures and shows the code', async () => {
    let outcome = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/login-records': (url) => {
        outcome = url.searchParams.get('outcome') ?? '';
        return {
          records: [record({ outcome: 'failed', code: 'INVALID_CREDENTIALS', second: null })],
        };
      },
      [`GET /n/${OTHER}/api/auth/login-records`]: () => ({ records: [] }),
    });
    await auth.run(cli, ['history', '--failed', '--limit', '10']);
    expect(outcome).toBe('failed');
    expect(stdout.text()).toContain('INVALID_CREDENTIALS');
    expect(stdout.text()).toContain('CODE');
  });

  test('a named offline node exits 5', async () => {
    const { ctx: cli, stderr } = await ctx({}, { node: 'down' });
    expect(await auth.run(cli, ['history'])).toBe(EXIT_NETWORK);
    expect(stderr.text()).toContain('skipped down: offline');
  });

  test('--limit 0 is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(auth.run(cli, ['history', '--limit', '0'])).rejects.toBeInstanceOf(UsageError);
  });

  test('clear requires --yes off a TTY and then deletes on reachable nodes', async () => {
    const { ctx: cli } = await ctx({});
    await expect(auth.run(cli, ['history', 'clear'])).rejects.toBeInstanceOf(UsageError);
    const deleted: string[] = [];
    const { ctx: yes, stdout } = await ctx({
      'DELETE /api/auth/login-records': () => {
        deleted.push('self');
        return { deleted: 3 };
      },
      [`DELETE /n/${OTHER}/api/auth/login-records`]: () => {
        deleted.push('jp');
        return { deleted: 1 };
      },
    });
    expect(await auth.run(yes, ['history', 'clear', '--yes'])).toBe(0);
    expect(new Set(deleted)).toEqual(new Set(['self', 'jp']));
    expect(stdout.text()).toContain('cleared office: 3');
    expect(stdout.text()).toContain('cleared jp: 1');
  });

  test('retention get prints days and set forever writes 0', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/login-records/settings': () => ({ retentionDays: 90 }),
      [`GET /n/${OTHER}/api/auth/login-records/settings`]: () => ({ retentionDays: 0 }),
    });
    expect(await auth.run(cli, ['history', 'retention'])).toBe(0);
    expect(stdout.text()).toContain('90d');
    expect(stdout.text()).toContain('forever');

    let body = '';
    const { ctx: set } = await ctx({
      'PUT /api/auth/login-records/settings': (_url, init) => {
        body = String(init?.body);
        return { retentionDays: 0 };
      },
      [`PUT /n/${OTHER}/api/auth/login-records/settings`]: () => ({ retentionDays: 0 }),
    });
    expect(await auth.run(set, ['history', 'retention', 'forever'])).toBe(0);
    expect(JSON.parse(body)).toEqual({ retentionDays: 0 });
  });
});

describe('vibeterm auth policy', () => {
  const policyBody = {
    policy: {
      preset: 'standard',
      ipFailThreshold: 10,
      ipLockBaseMs: 15 * 60_000,
      ipLockMaxMs: 24 * 3_600_000,
      accountFailPerHour: 50,
      accountLockMs: 15 * 60_000,
      exemptLocal: true,
    },
    source: 'keylog',
    writable: true,
    blockers: [],
  };

  test('shows the effective policy', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/login-policy': () => policyBody,
    });
    expect(await auth.run(cli, ['policy'])).toBe(0);
    expect(stdout.text()).toContain('preset: standard');
    expect(stdout.text()).toContain('source: keylog');
    expect(stdout.text()).toContain('exempt local: yes');
    expect(stdout.text()).toContain('upgrade them before admit or readmit');
  });

  test('405 on an old node is an upgrade notice', async () => {
    const { ctx: cli, stderr } = await ctx({
      'GET /api/auth/login-policy': () => jsonResponse({ code: 'method_not_allowed' }, 405),
    });
    expect(await auth.run(cli, ['policy'])).toBe(0);
    expect(stderr.text()).toContain('needs upgrade to 2.10.0');
  });

  test('refuses to sign when a node blocks the write', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/auth/login-policy': () => ({
        ...policyBody,
        writable: false,
        blockers: [{ nodeId: OLD, name: 'legacy', version: '2.9.1' }],
      }),
    });
    const error = await auth.run(cli, ['policy', 'set', '--preset', 'relaxed']).catch((err) => err);
    expect(String(error)).toContain('legacy');
    expect(String(error)).toContain('2.9.1');
  });

  test('--preset and --custom cannot be combined', async () => {
    const { ctx: cli } = await ctx({});
    await expect(
      auth.run(cli, ['policy', 'set', '--preset', 'standard', '--custom'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('policy set signs a login-policy record', async () => {
    const password = 'pw';
    const kdf = generateKdfParams();
    const seed = await deriveSeed(password, kdf);
    const root = rootKeyFromSeed(seed);
    seed.fill(0);
    process.env.VIBETERM_PASSWORD = password;
    let keylog = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/mode': () => ({
        mode: 'mesh',
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
        passkeyAvailable: false,
        rootEpoch: 1,
        rootPublicKey: encodeBase64url(root.publicKey),
      }),
      'GET /api/auth/login-policy': () => policyBody,
      'GET /api/auth/keylog/head': () => ({
        seq: 4,
        hash: encodeBase64url(new Uint8Array(32).fill(2)),
        rootEpoch: 1,
      }),
      'POST /api/auth/keylog': (_url, init) => {
        keylog = String(init?.body);
        return { ok: true, seq: 5, hubAck: true };
      },
    });
    expect(await auth.run(cli, ['policy', 'set', '--preset', 'relaxed'])).toBe(0);
    expect(stdout.text()).toContain('login policy set to relaxed');
    const rec = decodeKeyLogRecord(decodeBase64url(JSON.parse(keylog).bytes));
    expect(rec.type).toBe('login-policy');
    const payload = decodeLoginPolicyPayload(rec.payload);
    expect(payload.preset).toBe('relaxed');
    expect(payload.ip_fail_threshold).toBe(20);
    expect(payload.exempt_local).toBe(true);
    root.seed.fill(0);
  });
});
