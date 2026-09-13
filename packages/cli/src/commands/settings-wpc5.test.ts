import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeNotificationSinkPayload,
  deriveSeed,
  encodeBase64url,
  generateKdfParams,
  nodeIdToHex,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { CliError, UsageError } from '../core/errors';
import { NODE, routeFetch, testContext } from './cli-test-harness';
import { command as settings } from './settings';

const dirs: string[] = [];
const HASH = encodeBase64url(new Uint8Array(32).fill(2));

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  delete process.env.VIBETERM_TAVILY_API_KEY;
  delete process.env.VIBETERM_BRAVE_API_KEY;
  delete process.env.VIBETERM_TLS_DNS_TOKEN;
  delete process.env.VIBETERM_TLS_DNS_SECRET_ID;
  delete process.env.VIBETERM_TUNNEL_API_TOKEN;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function ctx(routes: Parameters<typeof routeFetch>[0]) {
  const built = await testContext(routeFetch(routes), { json: true });
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
      rootEpoch: 1,
      rootPublicKey: encodeBase64url(root.publicKey),
    },
  };
}

const SHORTCUTS = {
  settings: {
    items: [
      { id: 'enter', type: 'send', label: 'Enter', payload: '\r' },
      { id: 'esc', type: 'send', label: 'ESC', payload: '\x1b' },
    ],
    useIcons: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

describe('settings WPC5 field-level commands', () => {
  test('notifications mesh set signs notification-sink then PUT', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    const order: string[] = [];
    let keylog = '';
    let put = '';
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH, rootEpoch: 1 }),
      'POST /api/auth/keylog': (_url, init) => {
        order.push('keylog');
        keylog = String(init?.body);
        return { ok: true, seq: 5, hubAck: true, relayAck: true };
      },
      'PUT /api/notifications/mesh': (_url, init) => {
        order.push('put');
        put = String(init?.body);
        return { supported: true, selfEnabled: true, sinks: [] };
      },
    });
    await settings.run(cli, ['notifications', 'mesh', 'set', 'on']);
    expect(order).toEqual(['keylog', 'put']);
    expect(JSON.parse(put)).toEqual({ enabled: true });
    const rec = decodeKeyLogRecord(decodeBase64url(JSON.parse(keylog).bytes));
    expect(rec.type).toBe('notification-sink');
    const payload = decodeNotificationSinkPayload(rec.payload);
    expect(payload.enabled).toBe(true);
    expect(nodeIdToHex(payload.node_id)).toBe(NODE);
  });

  test('notifications mesh set does not PUT when hubAck is false', async () => {
    const signed = await signingMode();
    process.env.VIBETERM_PASSWORD = signed.password;
    let put = false;
    const { ctx: cli } = await ctx({
      'GET /api/auth/mode': () => signed.json,
      'GET /api/auth/keylog/head': () => ({ seq: 4, hash: HASH, rootEpoch: 1 }),
      'POST /api/auth/keylog': () => ({ ok: true, hubAck: false, hubError: 'no ack' }),
      'PUT /api/notifications/mesh': () => {
        put = true;
        return { supported: true };
      },
    });
    await expect(settings.run(cli, ['notifications', 'mesh', 'set', 'off'])).rejects.toBeInstanceOf(
      CliError
    );
    expect(put).toBe(false);
  });

  test('llm providers enable / disable PATCH {enabled}', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/llm/providers/p1': (_url, init) => {
        body = String(init?.body);
        return { provider: { id: 'p1', enabled: true } };
      },
    });
    await settings.run(cli, ['llm', 'providers', 'enable', 'p1']);
    expect(JSON.parse(body)).toEqual({ enabled: true });
    await settings.run(cli, ['llm', 'providers', 'disable', 'p1']);
    expect(JSON.parse(body)).toEqual({ enabled: false });
  });

  test('llm providers models PATCH manualModels / disabledModels', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/llm/providers/p1': (_url, init) => {
        body = String(init?.body);
        return { provider: { id: 'p1' } };
      },
    });
    await settings.run(cli, [
      'llm',
      'providers',
      'models',
      'p1',
      '--manual',
      'a,b',
      '--disable',
      'c',
    ]);
    expect(JSON.parse(body)).toEqual({ manualModels: ['a', 'b'], disabledModels: ['c'] });
    await settings.run(cli, ['llm', 'providers', 'models', 'p1', '--clear-manual']);
    expect(JSON.parse(body)).toEqual({ manualModels: [] });
  });

  test('llm default PATCH provider+model; search set keys never required on argv', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/llm/settings': (_url, init) => {
        body = String(init?.body);
        return { settings: {} };
      },
    });
    await settings.run(cli, ['llm', 'default', '--provider', 'p1', '--model', 'gpt-4']);
    expect(JSON.parse(body)).toEqual({ defaultProviderId: 'p1', defaultModelId: 'gpt-4' });
    process.env.VIBETERM_TAVILY_API_KEY = 'tv-secret';
    await settings.run(cli, ['llm', 'search', 'set', 'tavily']);
    expect(JSON.parse(body)).toEqual({ searchProvider: 'tavily', tavilyApiKey: 'tv-secret' });
    await settings.run(cli, ['llm', 'search', 'set', 'none', '--clear-keys']);
    expect(JSON.parse(body)).toEqual({
      searchProvider: 'none',
      tavilyApiKey: '',
      braveApiKey: '',
    });
    await settings.run(cli, ['llm', 'set', '--body', '{"searchProvider":"brave"}']);
    expect(JSON.parse(body)).toEqual({ searchProvider: 'brave' });
  });

  test('tls set --mode maps like TlsApi.update; --body still overrides', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PUT /api/tls': (_url, init) => {
        body = String(init?.body);
        return { mode: 'selfsigned' };
      },
    });
    await settings.run(cli, [
      'tls',
      'set',
      '--mode',
      'selfsigned',
      '--sans',
      'hub.lan,192.168.1.10',
      '--port',
      '9443',
      '--bind-host',
      '0.0.0.0',
    ]);
    expect(JSON.parse(body)).toEqual({
      mode: 'selfsigned',
      sans: ['hub.lan', '192.168.1.10'],
      tlsPort: 9443,
      bindHost: '0.0.0.0',
    });
    await settings.run(cli, ['tls', 'set', '--mode', 'none', '--yes']);
    expect(JSON.parse(body)).toEqual({ mode: 'none' });
    await settings.run(cli, ['tls', 'set', '--mode', 'external', '--trust-proxy', 'on', '--yes']);
    expect(JSON.parse(body)).toEqual({ mode: 'external', trustProxy: true });
    process.env.VIBETERM_TLS_DNS_TOKEN = 'cf-tok';
    await settings.run(cli, [
      'tls',
      'set',
      '--mode',
      'acme',
      '--domain',
      'hub.example.com',
      '--email',
      'ops@example.com',
      '--challenge',
      'dns-01',
      '--dns-provider',
      'cloudflare',
    ]);
    expect(JSON.parse(body)).toEqual({
      mode: 'acme',
      domain: 'hub.example.com',
      email: 'ops@example.com',
      challenge: 'dns-01',
      staging: false,
      tlsPort: 9443,
      bindHost: '0.0.0.0',
      dnsProvider: 'cloudflare',
      dnsCredentials: { token: 'cf-tok' },
    });
    await settings.run(cli, ['tls', 'set', '--body', '{"mode":"none"}', '--yes']);
    expect(JSON.parse(body)).toEqual({ mode: 'none' });
  });

  test('tls set acme dnspod sends dnsCredentials {id,token}', async () => {
    let body = '';
    process.env.VIBETERM_TLS_DNS_TOKEN = 'dp-tok';
    process.env.VIBETERM_TLS_DNS_SECRET_ID = 'id-1';
    const { ctx: cli } = await ctx({
      'PUT /api/tls': (_url, init) => {
        body = String(init?.body);
        return { mode: 'acme' };
      },
    });
    await settings.run(cli, [
      'tls',
      'set',
      '--mode',
      'acme',
      '--domain',
      'hub.example.com',
      '--email',
      'ops@example.com',
      '--challenge',
      'dns-01',
      '--dns-provider',
      'dnspod',
    ]);
    expect(JSON.parse(body)).toMatchObject({
      dnsProvider: 'dnspod',
      dnsCredentials: { id: 'id-1', token: 'dp-tok' },
    });
  });

  test('tunnel Access flags: set_access_mode / credentials / configure_access', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/tunnel/status': () => ({
        config: { mode: 'off', hostname: null },
      }),
      'POST /api/tunnel/actions': (_url, init) => {
        body = String(init?.body);
        return { status: {}, job: null };
      },
    });
    await settings.run(cli, ['tunnel', 'set_access_mode', '--access-mode', 'login']);
    expect(JSON.parse(body)).toEqual({ action: 'set_access_mode', accessMode: 'login' });
    process.env.VIBETERM_TUNNEL_API_TOKEN = 'cf-api';
    await settings.run(cli, ['tunnel', 'set_access_credentials', '--account-id', 'acc-1']);
    expect(JSON.parse(body)).toEqual({
      action: 'set_access_credentials',
      apiToken: 'cf-api',
      accountId: 'acc-1',
    });
    await settings.run(cli, [
      'tunnel',
      'configure_access',
      '--rule',
      'email:ops@example.com',
      '--rule',
      'domain:example.com',
      '--hostname',
      'draft.example.com',
    ]);
    expect(JSON.parse(body)).toEqual({
      action: 'configure_access',
      rules: [
        { kind: 'email', value: 'ops@example.com' },
        { kind: 'email_domain', value: 'example.com' },
      ],
      hostname: 'draft.example.com',
    });
  });

  test('configure_access omits hostname when the tunnel is already up', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'GET /api/tunnel/status': () => ({
        config: { mode: 'named', hostname: 'live.example.com' },
      }),
      'POST /api/tunnel/actions': (_url, init) => {
        body = String(init?.body);
        return { status: {}, job: null };
      },
    });
    await settings.run(cli, [
      'tunnel',
      'configure_access',
      '--rule',
      'email:ops@example.com',
      '--hostname',
      'draft.example.com',
    ]);
    expect(JSON.parse(body)).toEqual({
      action: 'configure_access',
      rules: [{ kind: 'email', value: 'ops@example.com' }],
    });
  });

  test('tunnel set_access_mode --body still overrides', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/tunnel/actions': (_url, init) => {
        body = String(init?.body);
        return { status: {}, job: null };
      },
    });
    await settings.run(cli, ['tunnel', 'set_access_mode', '--body', '{"accessMode":"cloudflare"}']);
    expect(JSON.parse(body)).toEqual({
      action: 'set_access_mode',
      accessMode: 'cloudflare',
    });
  });

  test('shortcuts add/rm/order/use-icons are read-modify-write', async () => {
    let stored = structuredClone(SHORTCUTS);
    let patch = '';
    const { ctx: cli } = await ctx({
      'GET /api/settings/terminal-shortcuts': () => stored,
      'PATCH /api/settings/terminal-shortcuts': (_url, init) => {
        patch = String(init?.body);
        const body = JSON.parse(patch) as { items: unknown; useIcons: boolean };
        stored = {
          settings: {
            items: body.items as typeof stored.settings.items,
            useIcons: body.useIcons,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        };
        return stored;
      },
    });
    await settings.run(cli, ['shortcuts', 'add', '--label', 'TAB', '--keys', '\\t']);
    const added = JSON.parse(patch) as {
      items: Array<{ id: string; type: string; label: string; payload?: string }>;
      useIcons: boolean;
    };
    expect(added.useIcons).toBe(false);
    expect(added.items).toHaveLength(3);
    expect(added.items[2]).toMatchObject({ type: 'send', label: 'TAB', payload: '\t' });
    expect(added.items[2].id.length).toBeGreaterThan(0);

    await settings.run(cli, ['shortcuts', 'rm', 'ESC']);
    expect(JSON.parse(patch).items.map((item: { id: string }) => item.id)).toEqual([
      'enter',
      added.items[2].id,
    ]);

    await settings.run(cli, ['shortcuts', 'order', '--ids', `${added.items[2].id},enter`]);
    expect(JSON.parse(patch).items.map((item: { id: string }) => item.id)).toEqual([
      added.items[2].id,
      'enter',
    ]);

    await settings.run(cli, ['shortcuts', 'use-icons', 'on']);
    expect(JSON.parse(patch)).toMatchObject({ useIcons: true });
  });

  test('shortcuts add --icon paste appends an action item', async () => {
    let patch = '';
    const { ctx: cli } = await ctx({
      'GET /api/settings/terminal-shortcuts': () => structuredClone(SHORTCUTS),
      'PATCH /api/settings/terminal-shortcuts': (_url, init) => {
        patch = String(init?.body);
        return SHORTCUTS;
      },
    });
    await settings.run(cli, ['shortcuts', 'add', '--icon', 'paste']);
    const items = JSON.parse(patch).items as Array<{ type: string; action?: string }>;
    expect(items.at(-1)).toMatchObject({ type: 'action', action: 'paste' });
  });

  test('llm / tls / tunnel / shortcuts reject incomplete flags', async () => {
    const { ctx: cli } = await ctx({});
    await expect(settings.run(cli, ['llm', 'default'])).rejects.toBeInstanceOf(UsageError);
    await expect(settings.run(cli, ['llm', 'search', 'set', 'google'])).rejects.toBeInstanceOf(
      UsageError
    );
    await expect(settings.run(cli, ['tls', 'set'])).rejects.toBeInstanceOf(UsageError);
    await expect(settings.run(cli, ['tunnel', 'set_access_mode'])).rejects.toBeInstanceOf(
      UsageError
    );
    await expect(settings.run(cli, ['shortcuts', 'add'])).rejects.toBeInstanceOf(UsageError);
  });
});
