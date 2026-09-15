import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFetch, testContext } from '../commands/cli-test-harness';
import { command as nodes } from '../commands/nodes';
import { AuthError, CliError, NetworkError, NotFoundError, UsageError } from './errors';
import { rewriteBarePasswordFlag } from './nodes-relay';
import { formatRelayQuotaLine, formatRelayQuotaLines } from './nodes-relay-quota';

const dirs: string[] = [];
const RELAY_URL = 'https://relay-sh.example';
const OTHER_URL = 'https://relay-tk.example';

afterEach(async () => {
  delete process.env.VIBETERM_RELAY_JOIN_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0], json = true) {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

describe('rewriteBarePasswordFlag', () => {
  test('turns a trailing --password into --password=', () => {
    expect(rewriteBarePasswordFlag(['enroll', '--password'])).toEqual(['enroll', '--password=']);
    expect(rewriteBarePasswordFlag(['enroll', '--password', '--name', 'x'])).toEqual([
      'enroll',
      '--password=',
      '--name',
      'x',
    ]);
  });

  test('leaves --password <value> and other flags alone', () => {
    expect(
      rewriteBarePasswordFlag(['relay', 'password', 'set', RELAY_URL, '--password', 'secret123'])
    ).toEqual(['relay', 'password', 'set', RELAY_URL, '--password', 'secret123']);
    expect(rewriteBarePasswordFlag(['enroll', '--password-stdin'])).toEqual([
      'enroll',
      '--password-stdin',
    ]);
  });
});

describe('formatRelayQuotaLine', () => {
  test('prints usage over limits and converts bandwidth/file units', () => {
    expect(
      formatRelayQuotaLine(RELAY_URL, {
        maxNodes: 8,
        maxStreams: 32,
        bandwidthBytesPerSec: 1024 * 100,
        maxFileBytes: 50 * 1024 * 1024,
        currentNodes: 2,
        usage: {
          currentNodes: 3,
          currentStreams: 4,
          bandwidthBytesPerSec: 1024 * 12,
          bytesInPerSec: 1,
          bytesOutPerSec: 1,
        },
      })
    ).toBe(`quota ${RELAY_URL}: nodes 3/8  streams 4/32  bandwidth 12/100 KB/s  max-file 50 MB`);
  });

  test('uses ∞ for unlimited bandwidth and max-file', () => {
    expect(
      formatRelayQuotaLine(RELAY_URL, {
        maxNodes: 8,
        maxStreams: 16,
        bandwidthBytesPerSec: null,
        maxFileBytes: null,
      })
    ).toBe(`quota ${RELAY_URL}: nodes -/8  streams -/16  bandwidth ∞ KB/s  max-file ∞ MB`);
  });
});

describe('formatRelayQuotaLines', () => {
  test('is empty without quota', () => {
    expect(formatRelayQuotaLines(null, [{ url: RELAY_URL }])).toEqual([]);
  });

  test('prints one line per relay when status.quota is present', () => {
    const quota = { maxNodes: 4, maxStreams: 8, bandwidthBytesPerSec: 1024, maxFileBytes: null };
    expect(formatRelayQuotaLines(quota, [{ url: RELAY_URL }, { url: OTHER_URL }])).toEqual([
      `quota ${RELAY_URL}: nodes -/4  streams -/8  bandwidth -/1 KB/s  max-file ∞ MB`,
      `quota ${OTHER_URL}: nodes -/4  streams -/8  bandwidth -/1 KB/s  max-file ∞ MB`,
    ]);
  });
});

describe('vibeterm nodes relay password', () => {
  test('GET uses the attached relay when url is omitted', async () => {
    let seen = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        relays: [{ url: RELAY_URL, attached: true }],
      }),
      'GET /api/mesh/relay/password': (url) => {
        seen = url.searchParams.get('url') ?? '';
        return { known: true, password: 'join-secret', passwordEpoch: 3 };
      },
    });
    await nodes.run(cli, ['relay', 'password']);
    expect(seen).toBe(RELAY_URL);
    expect(JSON.parse(stdout.text())).toEqual({
      known: true,
      password: 'join-secret',
      passwordEpoch: 3,
    });
  });

  test('GET with an explicit url skips status', async () => {
    const hits: string[] = [];
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => {
        hits.push('status');
        return { mode: 'relay' };
      },
      'GET /api/mesh/relay/password': (url) => {
        hits.push(url.searchParams.get('url') ?? '');
        return { known: false, password: null, passwordEpoch: 0 };
      },
    });
    await nodes.run(cli, ['relay', 'password', OTHER_URL]);
    expect(hits).toEqual([OTHER_URL]);
  });

  test('GET human output prints known / password / epoch', async () => {
    const { ctx: cli, stdout } = await ctx(
      {
        'GET /api/mesh/relay/password': () => ({
          known: true,
          password: 'shown',
          passwordEpoch: 7,
        }),
      },
      false
    );
    await nodes.run(cli, ['relay', 'password', RELAY_URL]);
    expect(stdout.text()).toBe('known yes\npassword shown\nepoch 7\n');
  });

  test('GET without an attached relay is a not-found (exit 4) error', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/status': () => ({ mode: 'none', relays: [] }),
    });
    const error = (await nodes
      .run(cli, ['relay', 'password'])
      .catch((err) => err)) as NotFoundError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.exitCode).toBe(4);
    expect(error.message).toContain('no attached relay');
  });

  test('GET maps relay_not_attached to not-found', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/mesh/relay/password': () =>
        new Response(JSON.stringify({ code: 'relay_not_attached' }), { status: 404 }),
    });
    await expect(nodes.run(cli, ['relay', 'password', RELAY_URL])).rejects.toBeInstanceOf(
      NotFoundError
    );
  });

  test('set POSTs { url, next, mode: keep } from --password', async () => {
    let body: unknown;
    const { ctx: cli, stdout } = await ctx({
      'POST /api/mesh/relay/password': (_url, init) => {
        body = JSON.parse(String(init?.body));
        return { ok: true, passwordEpoch: 4 };
      },
    });
    await nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--password', 'secret123']);
    expect(body).toEqual({ url: RELAY_URL, next: 'secret123', mode: 'keep' });
    expect(JSON.parse(stdout.text())).toEqual({ ok: true, passwordEpoch: 4 });
  });

  test('set --password-file reads the next password', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vt-relay-pw-'));
    dirs.push(dir);
    const file = join(dir, 'pw');
    await writeFile(file, 'file-secret\n');
    let body: unknown;
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': (_url, init) => {
        body = JSON.parse(String(init?.body));
        return { ok: true, passwordEpoch: 1 };
      },
    });
    await nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--password-file', file]);
    expect(body).toEqual({ url: RELAY_URL, next: 'file-secret', mode: 'keep' });
  });

  test('set --clear sends next: null and requires --yes off-tty', async () => {
    let body: unknown;
    const { ctx: cli, stdout } = await ctx(
      {
        'POST /api/mesh/relay/password': (_url, init) => {
          body = JSON.parse(String(init?.body));
          return { ok: true, passwordEpoch: 9 };
        },
      },
      false
    );
    await nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--clear', '--yes']);
    expect(body).toEqual({ url: RELAY_URL, next: null, mode: 'keep' });
    expect(stdout.text()).toContain(`cleared enroll password for ${RELAY_URL}`);
    expect(stdout.text()).toContain('epoch 9');
  });

  test('set --clear without --yes is a usage error off-tty', async () => {
    const { ctx: cli } = await ctx({});
    await expect(
      nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--clear'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('set --kick sends mode kick and includes --current', async () => {
    let body: unknown;
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': (_url, init) => {
        body = JSON.parse(String(init?.body));
        return { ok: true, passwordEpoch: 2 };
      },
    });
    await nodes.run(cli, [
      'relay',
      'password',
      'set',
      RELAY_URL,
      '--password',
      'secret123',
      '--current',
      'old-secret',
      '--kick',
      '--yes',
    ]);
    expect(body).toEqual({
      url: RELAY_URL,
      current: 'old-secret',
      next: 'secret123',
      mode: 'kick',
    });
  });

  test('set --kick and --keep together is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(
      nodes.run(cli, [
        'relay',
        'password',
        'set',
        RELAY_URL,
        '--password',
        'secret123',
        '--kick',
        '--keep',
      ])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('set maps relay_password_invalid to a CliError, not login-required', async () => {
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': () =>
        new Response(JSON.stringify({ code: 'relay_password_invalid' }), { status: 401 }),
    });
    const error = (await nodes
      .run(cli, ['relay', 'password', 'set', RELAY_URL, '--password', 'secret123'])
      .catch((err) => err)) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect(error.code).toBe('relay_password_invalid');
    expect(error.exitCode).toBe(1);
  });

  test('set maps UNAUTHORIZED 401 to login-required', async () => {
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': () =>
        new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401 }),
    });
    await expect(
      nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--password', 'secret123'])
    ).rejects.toBeInstanceOf(AuthError);
  });

  test('set maps relay_members_offline with counts', async () => {
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': () =>
        new Response(JSON.stringify({ code: 'relay_members_offline', online: 1, admitted: 3 }), {
          status: 409,
        }),
    });
    const error = (await nodes
      .run(cli, [
        'relay',
        'password',
        'set',
        RELAY_URL,
        '--password',
        'secret123',
        '--kick',
        '--yes',
      ])
      .catch((err) => err)) as CliError;
    expect(error.code).toBe('relay_members_offline');
    expect(error.message).toContain('1/3');
  });

  test('set maps relay_unreachable to a network error', async () => {
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': () =>
        new Response(JSON.stringify({ code: 'relay_unreachable' }), { status: 502 }),
    });
    await expect(
      nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--password', 'secret123'])
    ).rejects.toBeInstanceOf(NetworkError);
  });

  test('set rejects a too-short next password before POST', async () => {
    const hits: string[] = [];
    const { ctx: cli } = await ctx({
      'POST /api/mesh/relay/password': () => {
        hits.push('post');
        return { ok: true, passwordEpoch: 1 };
      },
    });
    await expect(
      nodes.run(cli, ['relay', 'password', 'set', RELAY_URL, '--password', 'short'])
    ).rejects.toBeInstanceOf(UsageError);
    expect(hits).toEqual([]);
  });

  test('enroll --password still prints a password join command', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => ({
        mode: 'relay',
        tenantId: 'ab'.repeat(16),
        relays: [{ url: RELAY_URL, attached: true }],
      }),
    });
    await nodes.run(cli, ['enroll', '--password']);
    expect(JSON.parse(stdout.text()).joinCommand).toContain('vibeterm relay join');
  });
});

describe('vibeterm nodes relay ls quota', () => {
  test('human output prints quota lines after the table', async () => {
    const { ctx: cli, stdout } = await ctx(
      {
        'GET /api/mesh/relay/status': () => ({
          mode: 'relay',
          quota: {
            maxNodes: 8,
            maxStreams: 16,
            bandwidthBytesPerSec: 2048,
            maxFileBytes: 10 * 1024 * 1024,
            usage: {
              currentNodes: 2,
              currentStreams: 3,
              bandwidthBytesPerSec: 1024,
              bytesInPerSec: 0,
              bytesOutPerSec: 0,
            },
          },
          relays: [{ url: RELAY_URL, attached: true, role: 'primary', online: true }],
        }),
      },
      false
    );
    await nodes.run(cli, ['relay', 'ls']);
    const text = stdout.text();
    expect(text).toContain('URL');
    expect(text).toContain(
      `quota ${RELAY_URL}: nodes 2/8  streams 3/16  bandwidth 1/2 KB/s  max-file 10 MB`
    );
  });

  test('--json is the raw status payload without extra quota lines', async () => {
    const status = {
      mode: 'relay',
      quota: { maxNodes: 8, maxStreams: 16, bandwidthBytesPerSec: null },
      relays: [{ url: RELAY_URL, attached: true }],
    };
    const { ctx: cli, stdout } = await ctx({
      'GET /api/mesh/relay/status': () => status,
    });
    await nodes.run(cli, ['relay', 'ls']);
    expect(JSON.parse(stdout.text())).toEqual(status);
    expect(stdout.text()).not.toContain('quota ');
  });
});
