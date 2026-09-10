import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { UsageError } from '../core/errors';
import { routeFetch, testContext } from './cli-test-harness';
import { command as settings } from './settings';

const dirs: string[] = [];

afterEach(async () => {
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
});
