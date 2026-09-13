import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { encodeBase32 } from '@vibeterm/shared/auth';
import { generateTotpSecret } from '../core/account-security';
import { AuthError, UsageError } from '../core/errors';
import { NODE, meshNode, routeFetch, testContext } from './cli-test-harness';
import { command as settings } from './settings';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  delete process.env.VIBETERM_NEW_PASSWORD;
  delete process.env.VIBETERM_TELEGRAM_TOKEN;
  delete process.env.VIBETERM_TOTP;
  delete process.env.VIBETERM_TOTP_SECRET;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
  dirs.push(built.dir);
  return built;
}

describe('vibeterm settings', () => {
  test('site get / set', async () => {
    let patch = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/settings/site': () => ({ settings: { siteName: 'VibeTerm' } }),
      'PATCH /api/settings/site': (_url, init) => {
        patch = String(init?.body);
        return { settings: { siteName: 'Desk' } };
      },
    });
    await settings.run(cli, ['site', 'get']);
    expect(JSON.parse(stdout.text()).settings.siteName).toBe('VibeTerm');
    await settings.run(cli, ['site', 'set', 'siteName', 'Desk']);
    expect(JSON.parse(patch)).toEqual({ siteName: 'Desk' });
  });

  test('site set rejects unknown keys', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['site', 'set', 'nope', 'x'])).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test('notifications mesh set', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PUT /api/notifications/mesh': (_url, init) => {
        body = String(init?.body);
        return { supported: true, selfEnabled: true, sinks: [] };
      },
    });
    await settings.run(cli, ['notifications', 'mesh', 'set', 'on']);
    expect(JSON.parse(body)).toEqual({ enabled: true });
  });

  test('webhooks add', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/webhooks': (_url, init) => {
        body = String(init?.body);
        return { webhook: { id: 'w-1' } };
      },
    });
    await settings.run(cli, ['webhooks', 'add', '--url', 'https://example/hook', '--secret', 's']);
    expect(JSON.parse(body)).toMatchObject({ url: 'https://example/hook', secret: 's' });
  });

  test('webhooks edit validates the new body before DELETE', async () => {
    const methods: string[] = [];
    const { ctx: cli } = await ctx({
      'DELETE /api/webhooks/w-1': () => {
        methods.push('DELETE');
        return { ok: true };
      },
      'POST /api/webhooks': () => {
        methods.push('POST');
        return { webhook: { id: 'w-2' } };
      },
    });
    await expect(settings.run(cli, ['webhooks', 'edit', 'w-1', '--yes'])).rejects.toBeInstanceOf(
      UsageError
    );
    expect(methods).toEqual([]);
  });

  test('tls set mode none requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({});
    await expect(
      settings.run(cli, ['tls', 'set', '--body', '{"mode":"none"}'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('tunnel --trust-proxy on requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({});
    await expect(
      settings.run(cli, ['tunnel', 'set_trust_proxy', '--trust-proxy', 'on'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('local leave without password requires --skip-self-revoke', async () => {
    const { ctx: cli } = await ctx({});
    const error = (await settings
      .run(cli, ['local', 'leave', '--yes', '--expected-role', 'node'])
      .catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.hint).toContain('--skip-self-revoke');
  });

  test('local leave --skip-self-revoke posts leave', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/local/leave': (_url, init) => {
        body = String(init?.body);
        return { ok: true };
      },
    });
    await settings.run(cli, [
      'local',
      'leave',
      '--yes',
      '--skip-self-revoke',
      '--expected-role',
      'node',
    ]);
    expect(JSON.parse(body)).toEqual({ expectedRole: 'node' });
  });

  test('llm providers ls and get', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/llm/providers': () => ({ providers: [] }),
    });
    await settings.run(cli, ['llm', 'providers', 'ls']);
    expect(JSON.parse(stdout.text()).providers).toEqual([]);
  });

  test('domain-access set off', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/system/domain-access': (_url, init) => {
        body = String(init?.body);
        return { allowed: false, viaDomain: false, hosts: [] };
      },
    });
    await settings.run(cli, ['domain-access', 'set', 'off']);
    expect(JSON.parse(body)).toEqual({ allowed: false });
  });

  test('tls get is entry-self', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/tls': () => ({ mode: 'none' }),
    });
    await settings.run(cli, ['tls', 'get']);
    expect(JSON.parse(stdout.text()).mode).toBe('none');
  });

  test('tunnel start posts an action', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/tunnel/actions': (_url, init) => {
        body = String(init?.body);
        return { status: { mode: 'named' }, job: null };
      },
    });
    await settings.run(cli, ['tunnel', 'start', '--acknowledge']);
    expect(JSON.parse(body)).toMatchObject({ action: 'start', acknowledgeExposure: true });
  });

  test('system info / upgrade start', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/system/info': () => ({ version: '2.0.8' }),
      'POST /api/system/upgrade': (_url, init) => {
        body = String(init?.body);
        return { state: 'downloading' };
      },
    });
    await settings.run(cli, ['system', 'info']);
    expect(JSON.parse(stdout.text()).version).toBe('2.0.8');
    await settings.run(cli, ['system', 'upgrade', 'start', '--version', '2.0.9']);
    expect(JSON.parse(body)).toEqual({ version: '2.0.9' });
  });

  test('local leave requires expected-role', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['local', 'leave', '--yes'])).rejects.toBeInstanceOf(UsageError);
  });

  test('restart requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['restart'])).rejects.toBeInstanceOf(UsageError);
  });

  test('system update-check hits GET /api/system/update-check', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/system/update-check': () => ({
        currentVersion: '2.3.5',
        latestVersion: '2.3.6',
        hasUpdate: true,
        changelog: null,
        publishedAt: null,
      }),
    });
    await settings.run(cli, ['system', 'update-check']);
    expect(JSON.parse(stdout.text()).hasUpdate).toBe(true);
  });

  test('local direct honours --node', async () => {
    const remote = 'b'.repeat(32);
    const seen: string[] = [];
    const built = await testContext(
      routeFetch({
        'GET /api/auth/mode': () => ({ mode: 'mesh', nodeId: NODE }),
        'GET /api/mesh/nodes': () => ({ nodes: [meshNode({ id: remote, name: 'edge' })] }),
        [`POST /n/${remote}/api/local/direct`]: (_url, init) => {
          seen.push(String(init?.body));
          return { ok: true };
        },
      }),
      { json: true, node: remote }
    );
    dirs.push(built.dir);
    await settings.run(built.ctx, ['local', 'direct', 'enable']);
    expect(JSON.parse(seen[0])).toEqual({ action: 'enable' });
  });

  test('local-auth bootstrap and set', async () => {
    process.env.VIBETERM_PASSWORD = 'local-pass-word';
    let boot = '';
    let toggle = '';
    const { ctx: cli } = await ctx({
      'POST /api/auth/local/bootstrap': (_url, init) => {
        boot = String(init?.body);
        return {
          ok: true,
          localAuth: {
            supported: true,
            enabled: false,
            effective: false,
            credentialsPresent: true,
          },
        };
      },
      'POST /api/auth/local': (_url, init) => {
        toggle = String(init?.body);
        return {
          ok: true,
          localAuth: { supported: true, enabled: true, effective: true, credentialsPresent: true },
        };
      },
    });
    await settings.run(cli, ['local-auth', 'bootstrap', '--user', 'ivy']);
    await settings.run(cli, ['local-auth', 'set', 'on']);
    expect(JSON.parse(boot)).toEqual({ username: 'ivy', password: 'local-pass-word' });
    expect(JSON.parse(toggle)).toEqual({ enabled: true });
  });

  test('telegram bots and chats hit the GUI REST surface', async () => {
    process.env.VIBETERM_TELEGRAM_TOKEN = 'bot-token';
    let created = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/settings/telegram/bots': () => ({ bots: [{ id: 'b1' }] }),
      'POST /api/settings/telegram/bots': (_url, init) => {
        created = String(init?.body);
        return { success: true };
      },
      'GET /api/settings/telegram/bots/b1/chats': () => ({ chats: [] }),
      'POST /api/settings/telegram/bots/b1/chats/-700/approve': () => ({
        chat: { chatId: '-700' },
      }),
      'POST /api/settings/telegram/bots/b1/chats/chat%3A2/test': () => ({ success: true }),
    });
    await settings.run(cli, ['telegram', 'ls']);
    expect(JSON.parse(stdout.text()).bots[0].id).toBe('b1');
    await settings.run(cli, ['telegram', 'add', '--name', 'ops']);
    expect(JSON.parse(created)).toMatchObject({ name: 'ops', token: 'bot-token' });
    await settings.run(cli, ['telegram', 'chats', 'ls', 'b1']);
    await settings.run(cli, ['telegram', 'chats', 'approve', 'b1', '-700']);
    await settings.run(cli, ['telegram', 'chats', 'test', 'b1', 'chat:2']);
  });

  test('weixin accounts, login and users', async () => {
    let created = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/settings/weixin/accounts': () => ({ accounts: [] }),
      'POST /api/settings/weixin/accounts': (_url, init) => {
        created = String(init?.body);
        return { success: true, accountId: 'a1' };
      },
      'POST /api/settings/weixin/accounts/a1/login/start': () => ({
        qrcodeUrl: 'https://q',
        qrcodeId: 'q1',
      }),
      'GET /api/settings/weixin/accounts/a1/users': () => ({ users: [] }),
      'POST /api/settings/weixin/accounts/a1/users/u%3A2/approve': () => ({
        user: { userId: 'u:2' },
      }),
    });
    await settings.run(cli, ['weixin', 'ls']);
    expect(JSON.parse(stdout.text()).accounts).toEqual([]);
    await settings.run(cli, ['weixin', 'add', '--name', 'ops']);
    expect(JSON.parse(created)).toEqual({ name: 'ops' });
    await settings.run(cli, ['weixin', 'login', 'start', 'a1']);
    await settings.run(cli, ['weixin', 'users', 'ls', 'a1']);
    await settings.run(cli, ['weixin', 'users', 'approve', 'a1', 'u:2']);
  });

  test('passkey ls prints the list and a browser-only hint', async () => {
    const { ctx: cli, stdout } = await ctx({
      'GET /api/auth/passkeys': () => ({
        passkeys: [{ credential_id: 'cred-1', name: 'laptop', origin: 'https://vt.example' }],
      }),
    });
    await settings.run(cli, ['passkey', 'ls']);
    const payload = JSON.parse(stdout.text()) as {
      passkeys: Array<{ credential_id: string }>;
      hint: string;
    };
    expect(payload.passkeys[0].credential_id).toBe('cred-1');
    expect(payload.hint).toContain('browser');
  });

  test('passkey rm requires --yes off-tty', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['passkey', 'rm', 'cred-1'])).rejects.toBeInstanceOf(UsageError);
  });

  test('totp enable --code invalid rejects before keylog', async () => {
    process.env.VIBETERM_PASSWORD = 'old-pass-word';
    process.env.VIBETERM_TOTP_SECRET = encodeBase32(generateTotpSecret());
    let keylog = false;
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => ({
        mode: 'mesh',
        nodeId: NODE,
        uid: 'user-1',
        kdfParams: { salt: 'AA', memory_kib: 65536, iterations: 3, parallelism: 1 },
        rootEpoch: 1,
        rootPublicKey: 'AA',
      }),
      'POST /api/auth/keylog': () => {
        keylog = true;
        return { ok: true, hubAck: true };
      },
    });
    await expect(settings.run(cli, ['totp', 'enable', '--code', '000000'])).rejects.toBeInstanceOf(
      AuthError
    );
    expect(keylog).toBe(false);
  });

  test('totp enable without a code is a usage error off-tty', async () => {
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => ({
        mode: 'mesh',
        nodeId: NODE,
        uid: 'user-1',
        kdfParams: { salt: 'AA', memory_kib: 65536, iterations: 3, parallelism: 1 },
        rootEpoch: 1,
        rootPublicKey: 'AA',
      }),
    });
    await expect(settings.run(cli, ['totp', 'enable'])).rejects.toBeInstanceOf(UsageError);
  });
});
