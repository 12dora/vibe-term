import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudflareAccessClient } from './access-client';
import { MemoryTunnelAccessStore } from './access-store';
import { MemoryTunnelConfigStore } from './config-store';
import { FakeSpawner, argsInclude } from './fake-spawn';
import { TunnelManager } from './manager';

async function waitJob(manager: TunnelManager, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = manager.status().job;
    if (job && job.state !== 'running') return job;
    await Bun.sleep(5);
  }
  throw new Error(`job did not finish: ${JSON.stringify(manager.status().job)}`);
}

async function waitState(manager: TunnelManager, state: string, timeoutMs = 2_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (manager.status().process.state === state) return;
    await Bun.sleep(5);
  }
  throw new Error(`state ${state} not reached: ${manager.status().process.state}`);
}

async function setup(overrides: ConstructorParameters<typeof TunnelManager>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-tun-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'vibeterm-tun-home-'));
  const spawner = new FakeSpawner();
  spawner.on((s) => argsInclude(s, '--version'), {
    stdout: 'cloudflared version 2025.8.1 (built 2025-08-01T00:00:00Z)\n',
  });
  const store = new MemoryTunnelConfigStore();
  const manager = new TunnelManager({
    tunnelDir: dir,
    homeDir,
    originPort: 19883,
    platform: 'linux',
    arch: 'arm64',
    store,
    spawner: spawner.spawn,
    which: () => '/usr/bin/cloudflared',
    downloader: async (_url, dest) => {
      await Bun.write(dest, 'fake-cloudflared');
    },
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    loginTimeoutMs: 200,
    loginPollMs: 5,
    killTimeoutMs: 20,
    runningWaitMs: 800,
    trustProxy: false,
    healthzStartedAt: 111,
    loginEnforced: () => true,
    registerAccessGuard: false,
    externalDetectDeps: {
      listProcesses: async () => '',
      readFile: async () => null,
      listDir: async () => [],
      homedir: () => homeDir,
      platform: 'linux',
    },
    ...overrides,
  });
  dirs.push(homeDir);
  return { dir, homeDir, spawner, store, manager };
}

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('TunnelManager', () => {
  test('parses version via injected spawner', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const result = await ctx.manager.handleAction({ action: 'install' });
    expect(result.httpStatus).toBe(202);
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('verify');
    const status = ctx.manager.status();
    expect(status.binary.installed).toBe(true);
    expect(status.binary.source).toBe('managed');
    expect(status.binary.version).toBe('2025.8.1');
    expect(ctx.spawner.calls.some((c) => argsInclude(c, '--version'))).toBe(true);
  });

  test('login parses URL, completes when cert.pem appears, and times out', async () => {
    const ctx = await setup({ loginTimeoutMs: 2_000 });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, 'login'), {
      hold: true,
      stdout: 'https://dash.cloudflare.com/argotunnel?aud=xyz\n',
    });
    const started = await ctx.manager.handleAction({ action: 'login' });
    expect(started.httpStatus).toBe(202);
    const start = Date.now();
    while (Date.now() - start < 1_000 && !ctx.manager.status().auth.loginUrl) {
      await Bun.sleep(5);
    }
    expect(ctx.manager.status().auth.loginUrl).toContain('dash.cloudflare.com/argotunnel');
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(ctx.manager.status().auth.loggedIn).toBe(true);
    expect(ctx.manager.status().auth.loginUrl).toBeNull();
    const loginLog = ctx.manager.status().log.join('\n');
    expect(loginLog).not.toContain('aud=xyz');
    expect(loginLog).not.toMatch(/https:\/\/dash\.cloudflare\.com\/[^\s]*\?/);

    const ctx2 = await setup({ loginTimeoutMs: 40, loginPollMs: 5 });
    dirs.push(ctx2.dir);
    ctx2.spawner.on((s) => argsInclude(s, 'login'), {
      hold: true,
      stdout: 'https://dash.cloudflare.com/argotunnel\n',
    });
    await ctx2.manager.handleAction({ action: 'login' });
    const timed = await waitJob(ctx2.manager, 1_000);
    expect(timed?.state).toBe('error');
    expect(timed?.error?.code).toBe('login_timeout');
  });

  test('create parses id, reuses existing, and surfaces dns_route_failed', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    ctx.spawner.once((s) => argsInclude(s, 'create'), {
      stdout:
        'Tunnel credentials written to /tmp/x.json\nCreated tunnel vibeterm-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
    });
    ctx.spawner.on((s) => argsInclude(s, 'dns'), { stdout: 'ok\n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection connIndex=0\n',
    });
    await ctx.manager.handleAction({ action: 'create', hostname: 'Remote.Example.com' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(ctx.manager.status().config.mode).toBe('named');
    expect(ctx.manager.status().config.hostname).toBe('remote.example.com');
    expect(ctx.manager.status().config.tunnelName).toBe('vibeterm-remote');
    expect(ctx.manager.status().config.tunnelId).toBe('550e8400-e29b-41d4-a716-446655440000');
    await waitState(ctx.manager, 'running');

    const ctx2 = await setup();
    dirs.push(ctx2.dir);
    await writeFile(join(ctx2.dir, 'cert.pem'), 'CERT', 'utf8');
    ctx2.spawner.once((s) => argsInclude(s, 'create'), {
      stderr: 'failed: already exists\n',
      exitCode: 1,
    });
    ctx2.spawner.on((s) => argsInclude(s, 'list'), {
      stdout: JSON.stringify([
        { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'vibeterm-remote' },
      ]),
    });
    ctx2.spawner.on((s) => argsInclude(s, 'dns'), { stdout: 'ok\n' });
    ctx2.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection\n',
    });
    await ctx2.manager.handleAction({ action: 'create', hostname: 'remote.example.com' });
    const reused = await waitJob(ctx2.manager);
    expect(reused?.state).toBe('done');
    expect(ctx2.manager.status().config.tunnelId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

    const ctx3 = await setup();
    dirs.push(ctx3.dir);
    await writeFile(join(ctx3.dir, 'cert.pem'), 'CERT', 'utf8');
    ctx3.spawner.once((s) => argsInclude(s, 'create'), {
      stdout: 'Created tunnel vibeterm-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
    });
    ctx3.spawner.on((s) => argsInclude(s, 'dns'), {
      stderr: 'An A, AAAA, or CNAME record with that host already exists.\n',
      exitCode: 1,
    });
    await ctx3.manager.handleAction({ action: 'create', hostname: 'remote.example.com' });
    const failed = await waitJob(ctx3.manager);
    expect(failed?.state).toBe('error');
    expect(failed?.error?.code).toBe('dns_route_failed');
    expect(failed?.error?.message).toContain('already exists');
  });

  test('quick_start parses trycloudflare URL into publicUrl', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(ctx.manager.status().config.mode).toBe('quick');
    expect(ctx.manager.status().process.publicUrl).toBe('https://lucky-cloud-9.trycloudflare.com');
    expect(ctx.manager.status().process.state).toBe('running');
  });

  test('supervisor restarts with backoff and stop disables it', async () => {
    const delays: number[] = [];
    const ctx = await setup({
      sleep: async (ms) => {
        delays.push(ms);
        await Bun.sleep(1);
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'Registered tunnel connection\nhttps://a.trycloudflare.com\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await waitState(ctx.manager, 'running');
    const firstPid = ctx.manager.status().process.pid;
    ctx.spawner.lastHandle()?.exit(1);
    const start = Date.now();
    while (Date.now() - start < 1_500 && ctx.manager.status().process.restarts < 1) {
      await Bun.sleep(5);
    }
    expect(ctx.manager.status().process.restarts).toBeGreaterThanOrEqual(1);
    expect(delays[0]).toBe(1_000);
    expect(ctx.manager.status().process.pid).not.toBe(firstPid);
    await ctx.manager.handleAction({ action: 'stop' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.state).toBe('stopped');
    const restarts = ctx.manager.status().process.restarts;
    await Bun.sleep(30);
    expect(ctx.manager.status().process.restarts).toBe(restarts);
  });

  test('redacts token-like strings in the log ring', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const token = 'f'.repeat(32);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: `token ${token}\nRegistered tunnel connection\nhttps://b.trycloudflare.com\n`,
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const log = ctx.manager.status().log.join('\n');
    expect(log).toContain('***');
    expect(log).not.toContain(token);
  });

  test('check compares healthz startedAt via injected fetch', async () => {
    const ctx = await setup({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/ready')) {
          return Response.json({ readyConnections: 4, connectorId: 'c1' });
        }
        expect(url).toBe('https://lucky-cloud-9.trycloudflare.com/healthz');
        return Response.json({ startedAt: 111 });
      }) as typeof fetch,
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('ok');
  });

  test('set_trust_proxy requires injected host env patch', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const missing = await ctx.manager.handleAction({ action: 'set_trust_proxy', trustProxy: true });
    expect(missing.httpStatus).toBe(400);
    expect('error' in missing.payload && missing.payload.error.code).toBe('not_configured');

    const writes: boolean[] = [];
    ctx.manager.setPatchHostEnv(async (value) => {
      writes.push(value);
    });
    const ok = await ctx.manager.handleAction({ action: 'set_trust_proxy', trustProxy: true });
    expect(ok.httpStatus).toBe(200);
    expect(writes).toEqual([true]);
    if ('status' in ok.payload) {
      expect(ok.payload.status.restartRequired).toBe(true);
      expect(ok.payload.status.trustProxy).toBe(false);
      expect(ok.payload.status.configuredTrustProxy).toBe(true);
    }
  });

  test('requires acknowledgeExposure when unprotected', async () => {
    const ctx = await setup({ loginEnforced: () => false });
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    const expected = {
      code: 'exposure_ack_required' as const,
      message:
        'This instance has no sign-in and no Cloudflare Access protection; confirm public exposure explicitly',
    };
    for (const body of [
      { action: 'quick_start' as const },
      { action: 'create' as const, hostname: 'remote.example.com' },
      { action: 'start' as const },
      { action: 'set_auto_start' as const, autoStart: true },
    ]) {
      const result = await ctx.manager.handleAction(body);
      expect(result.httpStatus).toBe(409);
      expect('error' in result.payload && result.payload.error).toEqual(expected);
    }
    const acked = await ctx.manager.handleAction({
      action: 'set_auto_start',
      autoStart: true,
      acknowledgeExposure: true,
    });
    expect(acked.httpStatus).toBe(200);
    expect(ctx.manager.status().config.autoStart).toBe(true);
    expect(ctx.manager.status().exposureProtected).toBe(false);
    const disable = await ctx.manager.handleAction({ action: 'set_auto_start', autoStart: false });
    expect(disable.httpStatus).toBe(200);
  });

  test('skips auto-start at boot when unprotected and unacknowledged', async () => {
    const warnings: string[] = [];
    const ctx = await setup({
      loginEnforced: () => false,
      warn: (message) => warnings.push(message),
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'quick', autoStart: true });
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://boot.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.start();
    expect(ctx.manager.status().process.state).toBe('stopped');
    expect(ctx.spawner.calls.some((c) => argsInclude(c, '--url'))).toBe(false);
    expect(warnings.some((w) => /confirm public exposure/i.test(w))).toBe(true);
  });

  test('rejects path-traversal tunnel names before writing credentials', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    for (const tunnelName of ['../../x', '/abs', 'foo\nbar', 'a'.repeat(64)]) {
      const result = await ctx.manager.handleAction({
        action: 'create',
        hostname: 'ok.example.com',
        tunnelName,
      });
      expect(result.httpStatus).toBe(400);
      expect('error' in result.payload && result.payload.error.code).toBe('invalid_request');
    }
    expect(ctx.spawner.calls.some((c) => argsInclude(c, 'create'))).toBe(false);
  });

  test('check job finishes as done/ok or error, never stuck on step check', async () => {
    const ctx = await setup({
      fetchImpl: (async (_input: RequestInfo | URL) => {
        return new Response('nope', { status: 503 });
      }) as typeof fetch,
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('error');
    expect(job?.error?.code).toBeTruthy();
    expect(job?.error?.message).toBeTruthy();
    expect(job?.error?.message).toMatch(/health check HTTP 503/);
    expect(job?.step).not.toBe('check');
  });

  test('edge HTTP failure includes known connector connection count', async () => {
    const ctx = await setup({
      pickPort: async () => 41234,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' }, { status: 503 });
        }
        return new Response('error code: 530', { status: 530 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await ctx.manager.handleAction({ action: 'check' });
    const down = await waitJob(ctx.manager);
    expect(down?.error?.code).toBe('connector_down');

    const ctx2 = await setup({
      pickPort: async () => 41234,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 4, connectorId: 'c' });
        }
        return new Response('error code: 530', { status: 530 });
      },
    });
    dirs.push(ctx2.dir);
    ctx2.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx2.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx2.manager);
    await ctx2.manager.handleAction({ action: 'check' });
    const failed = await waitJob(ctx2.manager);
    expect(failed?.state).toBe('error');
    expect(failed?.error?.message).toBe('health check HTTP 530 (connector: 4 edge connections)');
  });

  test('clears publicUrl on quick start/stop and does not leak named hostnames', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    ctx.spawner.once((s) => argsInclude(s, 'create'), {
      stdout: 'Created tunnel vibeterm-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
    });
    ctx.spawner.on((s) => argsInclude(s, 'dns'), { stdout: 'ok\n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'create', hostname: 'remote.example.com' });
    await waitJob(ctx.manager);
    await waitState(ctx.manager, 'running');
    expect(ctx.manager.status().process.publicUrl).toBe('https://remote.example.com');

    await ctx.manager.handleAction({ action: 'stop' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.publicUrl).toBeNull();

    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://fresh-cloud.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'remove' });
    await waitJob(ctx.manager);
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.publicUrl).toBe('https://fresh-cloud.trycloudflare.com');
    expect(ctx.manager.status().process.publicUrl).not.toBe('https://remote.example.com');

    await ctx.manager.handleAction({ action: 'stop' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.publicUrl).toBeNull();
  });

  test('create is rejected while a tunnel is already configured', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'quick', hostname: null, tunnelName: null, tunnelId: null });
    const result = await ctx.manager.handleAction({
      action: 'create',
      hostname: 'another.example.com',
    });
    expect(result.httpStatus).toBe(409);
    expect('error' in result.payload && result.payload.error.code).toBe('tunnel_exists');
  });

  test('passes originUrl from bind host into cloudflared', async () => {
    const ctx = await setup({ originUrl: 'http://[::1]:19883' });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://v6.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const quick = ctx.spawner.calls.find((c) => argsInclude(c, '--url'));
    expect(quick?.args).toContain('http://[::1]:19883');
  });

  test('configuredTrustProxy comes from host-env and drives restartRequired', async () => {
    let saved: boolean | null = true;
    const ctx = await setup({
      trustProxy: false,
      readHostEnv: async () => saved,
    });
    dirs.push(ctx.dir);
    await ctx.manager.start();
    expect(ctx.manager.status().trustProxy).toBe(false);
    expect(ctx.manager.status().configuredTrustProxy).toBe(true);
    expect(ctx.manager.status().restartRequired).toBe(true);

    ctx.manager.setPatchHostEnv(async (value) => {
      saved = value;
    });
    const ok = await ctx.manager.handleAction({ action: 'set_trust_proxy', trustProxy: false });
    expect(ok.httpStatus).toBe(200);
    if ('status' in ok.payload) {
      expect(ok.payload.status.configuredTrustProxy).toBe(false);
      expect(ok.payload.status.trustProxy).toBe(false);
      expect(ok.payload.status.restartRequired).toBe(false);
    }
  });

  test('set_access_credentials validates via organizations and stores teamDomain', async () => {
    const ctx = await setup({
      fetchImpl: async (input) => {
        expect(String(input)).toContain('/access/organizations');
        return Response.json({
          success: true,
          result: { auth_domain: 'acme.cloudflareaccess.com' },
        });
      },
    });
    dirs.push(ctx.dir);
    const result = await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'cf-token',
      accountId: 'account-1',
    });
    expect(result.httpStatus).toBe(200);
    const status = ctx.manager.status();
    expect(status.access.hasCredentials).toBe(true);
    expect(status.access.accountId).toBe('account-1');
    expect(status.access.teamDomain).toBe('acme.cloudflareaccess.com');
    expect(status.loginEnforced).toBe(true);
  });

  test('loginEnforcedFn 每次 status 都 live 读取，不是构造快照', async () => {
    let effective = false;
    const ctx = await setup({ loginEnforced: () => effective });
    dirs.push(ctx.dir);
    expect(ctx.manager.status().loginEnforced).toBe(false);
    effective = true;
    expect(ctx.manager.status().loginEnforced).toBe(true);
  });

  test('configure_access creates app, replaces policy, and enables JWT', async () => {
    let allowPolicy: Record<string, unknown> | null = null;
    const ctx = await setup({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.endsWith('/access/apps') && method === 'POST') {
          return Response.json({
            success: true,
            result: { id: 'app-1', aud: 'aud-1', domain: 'remote.example.com', name: 'vibeterm' },
          });
        }
        if (url.includes('/access/apps/app-1/policies') && method === 'GET') {
          return Response.json({ success: true, result: allowPolicy ? [allowPolicy] : [] });
        }
        if (url.includes('/access/apps/app-1/policies') && method === 'POST') {
          const body = JSON.parse(String(init?.body));
          allowPolicy = {
            id: 'pol-1',
            name: 'vibeterm-allow',
            decision: 'allow',
            include: body.include,
          };
          return Response.json({ success: true, result: allowPolicy });
        }
        if (url.endsWith('/access/apps/app-1') && method === 'GET') {
          return Response.json({
            success: true,
            result: { id: 'app-1', aud: 'aud-1', domain: 'remote.example.com', name: 'vibeterm' },
          });
        }
        return Response.json(
          { success: false, errors: [{ message: `unexpected ${method} ${url}` }] },
          { status: 400 }
        );
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com' });
    const queued = await ctx.manager.handleAction({
      action: 'configure_access',
      rules: [{ kind: 'email', value: 'owner@example.com' }],
    });
    expect(queued.httpStatus).toBe(202);
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('verify');
    const access = ctx.manager.status().access;
    expect(access.configured).toBe(true);
    expect(access.appId).toBe('app-1');
    expect(access.aud).toBe('aud-1');
    expect(access.enforceJwt).toBe(true);
    expect(access.hostname).toBe('remote.example.com');
    expect(access.effective).toBe(true);
    expect(ctx.manager.status().exposureProtected).toBe(true);
  });

  test('named start is allowed without ack when Access JWT is enforced for the hostname', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email_domain', value: 'example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({ loginEnforced: () => false, accessStore });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'ok.example.com', tunnelId: 'tid', tunnelName: 'n' });
    expect(ctx.manager.status().exposureProtected).toBe(true);
    const result = await ctx.manager.handleAction({ action: 'start' });
    expect(result.httpStatus).toBe(202);
  });

  test('adopt_external blocks start/stop while system-managed; remove releases the adoption', async () => {
    const ctx = await setup({
      loginEnforced: () => false,
      externalDetectDeps: {
        listProcesses: async () =>
          '  1 cloudflared tunnel --logfile /tmp/cf.log --token-file /tmp/tok run\n',
        readFile: async (path) => {
          if (path === '/tmp/tok') {
            return Buffer.from(JSON.stringify({ a: 'a', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/cf.log') {
            return '{"ingress":[{"hostname":"ext.example.com","service":"http://127.0.0.1:19883"}]}\n';
          }
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    const adopt = await ctx.manager.handleAction({
      action: 'adopt_external',
      hostname: 'ext.example.com',
    });
    expect(adopt.httpStatus).toBe(200);
    const status = ctx.manager.status();
    expect(status.config.externallyManaged).toBe(true);
    expect(status.config.mode).toBe('named');
    expect(status.config.hostname).toBe('ext.example.com');
    const start = await ctx.manager.handleAction({ action: 'start', acknowledgeExposure: true });
    expect(start.httpStatus).toBe(409);
    expect('error' in start.payload && start.payload.error.message).toBe(
      'managed by the system service'
    );
    const stop = await ctx.manager.handleAction({ action: 'stop' });
    expect(stop.httpStatus).toBe(409);
    const remove = await ctx.manager.handleAction({ action: 'remove' });
    expect(remove.httpStatus).toBe(200);
    const released = ctx.manager.status();
    expect(released.config.externallyManaged).toBe(false);
    expect(released.config.mode).toBe('off');
    expect(released.config.hostname).toBeNull();
    expect(released.external.detected).toBe(true);
  });

  test('set_access_credentials maps API failure and clear wipes token', async () => {
    const ctx = await setup({
      fetchImpl: async () =>
        Response.json(
          { success: false, errors: [{ message: 'Invalid API Token' }] },
          { status: 401 }
        ),
    });
    dirs.push(ctx.dir);
    const failed = await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'bad-token',
      accountId: 'acc',
    });
    expect(failed.httpStatus).toBe(400);
    expect('error' in failed.payload && failed.payload.error.code).toBe('access_api_failed');
    expect(ctx.manager.status().access.hasCredentials).toBe(false);
    expect(ctx.manager.status().access.lastError).toContain('Invalid API Token');
    expect(ctx.manager.status().access.lastError).toContain('Access: Organizations');

    const okCtx = await setup({
      fetchImpl: async (input) => {
        if (String(input).includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        return Response.json(
          { success: false, errors: [{ message: String(input) }] },
          { status: 400 }
        );
      },
    });
    dirs.push(okCtx.dir);
    await okCtx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    expect(okCtx.manager.status().access.hasCredentials).toBe(true);
    const cleared = await okCtx.manager.handleAction({ action: 'clear_access_credentials' });
    expect(cleared.httpStatus).toBe(200);
    expect(okCtx.manager.status().access.hasCredentials).toBe(false);
    expect(okCtx.manager.status().access.accountId).toBeNull();
  });

  test('sync_access copies dashboard Access app rules for the hostname', async () => {
    const ctx = await setup({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.includes('/access/apps?')) {
          return Response.json({
            success: true,
            result: [{ id: 'app-9', aud: 'aud-9', domain: 'remote.example.com', name: 'vibeterm' }],
            result_info: { page: 1, per_page: 100, total_count: 1, total_pages: 1 },
          });
        }
        if (url.includes('/access/apps/app-9/policies')) {
          return Response.json({
            success: true,
            result: [
              {
                id: 'pol-1',
                decision: 'allow',
                include: [{ email: { email: 'owner@example.com' } }],
              },
            ],
          });
        }
        return Response.json({ success: false, errors: [{ message: url }] }, { status: 400 });
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com' });
    const queued = await ctx.manager.handleAction({ action: 'sync_access' });
    expect(queued.httpStatus).toBe(202);
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    const access = ctx.manager.status().access;
    expect(access.configured).toBe(true);
    expect(access.appId).toBe('app-9');
    expect(access.aud).toBe('aud-9');
    expect(access.rules).toEqual([{ kind: 'email', value: 'owner@example.com' }]);
    expect(access.effective).toBe(false);
    expect(access.bypassAppId).toBeNull();
  });

  test('sync_access discovers a leftover tmex-bypass-hub app and remove_access deletes it', async () => {
    const deleted: string[] = [];
    const ctx = await setup({
      loginEnforced: () => true,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.includes('/access/apps?') && method === 'GET') {
          return Response.json({
            success: true,
            result: [
              { id: 'app-9', aud: 'aud-9', domain: 'remote.example.com', name: 'VibeTerm' },
              {
                id: 'bypass-hub',
                aud: 'aud-bh',
                domain: 'remote.example.com/hub/',
                name: 'tmex-bypass-hub',
              },
            ],
            result_info: { page: 1, per_page: 100, total_count: 2, total_pages: 1 },
          });
        }
        if (url.includes('/access/apps/app-9/policies')) {
          return Response.json({
            success: true,
            result: [
              {
                id: 'pol-1',
                decision: 'allow',
                include: [{ email: { email: 'owner@example.com' } }],
              },
            ],
          });
        }
        if (method === 'DELETE' && url.includes('/access/apps/')) {
          const id = url.split('/access/apps/').pop() ?? url;
          deleted.push(id);
          return Response.json({ success: true, result: {} });
        }
        return Response.json({ success: false, errors: [{ message: url }] }, { status: 400 });
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com' });
    const synced = await ctx.manager.handleAction({ action: 'sync_access' });
    expect(synced.httpStatus).toBe(202);
    const syncJob = await waitJob(ctx.manager);
    expect(syncJob?.state).toBe('done');
    expect(ctx.manager.status().access.bypassAppId).toBe('bypass-hub');

    const removed = await ctx.manager.handleAction({ action: 'remove_access' });
    expect(removed.httpStatus).toBe(202);
    const removeJob = await waitJob(ctx.manager);
    expect(removeJob?.state).toBe('done');
    expect(deleted).toContain('bypass-hub');
    expect(ctx.manager.status().access.bypassAppId).toBeNull();
  });

  test('configure_access with mesh role does not create retired hub bypass apps', async () => {
    const createdDomains: string[] = [];
    const policies = new Map<string, unknown[]>();
    const ctx = await setup({
      hasMeshRole: true,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.includes('/access/apps?') && method === 'GET') {
          return Response.json({
            success: true,
            result: [],
            result_info: { page: 1, per_page: 100, total_count: 0, total_pages: 1 },
          });
        }
        if (url.endsWith('/access/apps') && method === 'POST') {
          createdDomains.push(body.domain);
          const id = 'app-1';
          policies.set(id, []);
          return Response.json({
            success: true,
            result: { id, aud: `aud-${id}`, name: body.name, domain: body.domain },
          });
        }
        const polMatch = url.match(/\/access\/apps\/([^/]+)\/policies/);
        if (polMatch && method === 'GET') {
          return Response.json({ success: true, result: policies.get(polMatch[1] ?? '') ?? [] });
        }
        if (polMatch && method === 'POST') {
          const appId = polMatch[1] ?? '';
          const pol = {
            id: `pol-${appId}`,
            name: body.name,
            decision: body.decision,
            include: body.include,
          };
          policies.set(appId, [pol]);
          return Response.json({ success: true, result: pol });
        }
        if (url.endsWith('/access/apps/app-1') && method === 'GET') {
          return Response.json({
            success: true,
            result: {
              id: 'app-1',
              aud: 'aud-app-1',
              domain: 'remote.example.com',
              name: 'vibeterm',
            },
          });
        }
        return Response.json(
          { success: false, errors: [{ message: `${method} ${url}` }] },
          { status: 400 }
        );
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com' });
    await ctx.manager.handleAction({
      action: 'configure_access',
      rules: [{ kind: 'email', value: 'owner@example.com' }],
    });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(createdDomains).toEqual(['remote.example.com']);
    expect(ctx.manager.status().access.bypassAppId).toBeNull();
  });

  test('configure_access with explicit hostname works when mode is off', async () => {
    const captured = { domain: null as string | null };
    let allowPolicy: Record<string, unknown> | null = null;
    const ctx = await setup({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.endsWith('/access/apps') && method === 'POST') {
          captured.domain = typeof body.domain === 'string' ? body.domain : null;
          return Response.json({
            success: true,
            result: { id: 'app-h', aud: 'aud-h', domain: body.domain, name: 'vibeterm' },
          });
        }
        if (url.includes('/policies') && method === 'GET') {
          return Response.json({ success: true, result: allowPolicy ? [allowPolicy] : [] });
        }
        if (url.includes('/policies') && method === 'POST') {
          allowPolicy = {
            id: 'pol-h',
            name: 'vibeterm-allow',
            decision: 'allow',
            include: body.include,
          };
          return Response.json({ success: true, result: allowPolicy });
        }
        if (url.endsWith('/access/apps/app-h') && method === 'GET') {
          return Response.json({
            success: true,
            result: { id: 'app-h', aud: 'aud-h', domain: captured.domain, name: 'vibeterm' },
          });
        }
        return Response.json(
          { success: false, errors: [{ message: `${method} ${url}` }] },
          { status: 400 }
        );
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'set_access_credentials',
      apiToken: 'tok',
      accountId: 'acc',
    });
    expect(ctx.manager.status().config.mode).toBe('off');
    await ctx.manager.handleAction({
      action: 'configure_access',
      hostname: 'draft.example.com',
      rules: [{ kind: 'email', value: 'owner@example.com' }],
    });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(captured.domain).toBe('draft.example.com');
    expect(ctx.manager.status().access.hostname).toBe('draft.example.com');
    expect(ctx.manager.status().access.effective).toBe(false);
    ctx.store.save({ mode: 'named', hostname: 'draft.example.com' });
    expect(ctx.manager.status().exposureProtected).toBe(true);
    expect(ctx.manager.status().access.effective).toBe(true);
  });

  test('quick tunnel after named Access removal does not enforce the guard snapshot', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'old.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({ loginEnforced: () => false, accessStore });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start', acknowledgeExposure: true });
    await waitJob(ctx.manager);
    const status = ctx.manager.status();
    expect(status.config.mode).toBe('quick');
    expect(status.access.configured).toBe(true);
    expect(status.access.enforceJwt).toBe(true);
    expect(status.access.effective).toBe(false);
    expect(status.exposureProtected).toBe(false);
  });

  test('check treats Access login redirect without connector metrics as access_protected_unverified', async () => {
    const ctx = await setup({
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login' },
        }),
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('access_protected_unverified');
  });

  test('remove_access keeps local state when DELETE is not 404', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app-keep',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => true,
      accessStore,
      fetchImpl: async () =>
        Response.json({ success: false, errors: [{ message: 'Forbidden' }] }, { status: 403 }),
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({ action: 'remove_access' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('error');
    expect(job?.error?.code).toBe('access_api_failed');
    expect(ctx.manager.status().access.appId).toBe('app-keep');
    expect(ctx.manager.status().access.configured).toBe(true);
  });

  test('set_access_mode records the choice and status returns it without deriving', async () => {
    const ctx = await setup({ loginEnforced: () => false });
    dirs.push(ctx.dir);
    expect(ctx.manager.status().config.accessMode).toBeNull();
    const login = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'login',
    });
    expect(login.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('login');
    expect(ctx.manager.status().exposureProtected).toBe(false);
    const cloudflare = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'cloudflare',
    });
    expect(cloudflare.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('cloudflare');
  });

  test('set_access_mode none requires ack when running unprotected, stamps when acknowledged', async () => {
    let now = Date.parse('2026-09-02T00:00:00.000Z');
    const ctx = await setup({ loginEnforced: () => false, now: () => now });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'ok.example.com', tunnelId: 'tid', tunnelName: 'n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'start', acknowledgeExposure: true });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.state).toBe('running');
    expect(ctx.manager.status().exposureProtected).toBe(false);
    const stampedAtStart = ctx.store.get().exposureAcknowledgedAt;

    const denied = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(denied.httpStatus).toBe(409);
    expect('error' in denied.payload && denied.payload.error.code).toBe('exposure_ack_required');
    expect(ctx.manager.status().config.accessMode).toBeNull();

    const login = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'login',
    });
    expect(login.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('login');

    const cloudflare = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'cloudflare',
    });
    expect(cloudflare.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('cloudflare');

    now += 1000;
    const acked = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
      acknowledgeExposure: true,
    });
    expect(acked.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('none');
    expect(ctx.store.get().exposureAcknowledgedAt).toBe(new Date(now).toISOString());
    expect(ctx.store.get().exposureAcknowledgedAt).not.toBe(stampedAtStart);
    expect(ctx.manager.status().access.configured).toBe(false);
    expect(ctx.manager.status().loginEnforced).toBe(false);
  });

  test('set_access_mode none is allowed without ack when the tunnel is stopped', async () => {
    const ctx = await setup({ loginEnforced: () => false });
    dirs.push(ctx.dir);
    expect(ctx.manager.status().process.state).toBe('stopped');
    const result = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(result.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('none');
    expect(ctx.store.get().exposureAcknowledgedAt).toBeNull();
  });

  test('set_access_mode none requires ack after autostart timeout leaves the process enabled', async () => {
    const ctx = await setup({ loginEnforced: () => false, runningWaitMs: 40 });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      tunnelName: 'n',
      autoStart: true,
      exposureAcknowledgedAt: '2026-09-01T00:00:00.000Z',
    });
    ctx.spawner.on((s) => argsInclude(s, 'run'), { hold: true });
    await ctx.manager.start();
    expect(ctx.manager.status().process.state).toBe('error');
    expect(ctx.manager.status().process.pid).not.toBeNull();
    const denied = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(denied.httpStatus).toBe(409);
    expect('error' in denied.payload && denied.payload.error.code).toBe('exposure_ack_required');
    expect(ctx.manager.status().config.accessMode).toBeNull();
    await ctx.manager.stop();
  });

  test('set_access_mode none requires ack when the tunnel is starting or degraded', async () => {
    const starting = await setup({ loginEnforced: () => false, runningWaitMs: 2_000 });
    dirs.push(starting.dir);
    starting.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      tunnelName: 'n',
    });
    starting.spawner.on((s) => argsInclude(s, 'run'), { hold: true });
    const queued = await starting.manager.handleAction({
      action: 'start',
      acknowledgeExposure: true,
    });
    expect(queued.httpStatus).toBe(202);
    await waitState(starting.manager, 'starting');
    const deniedStarting = await starting.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(deniedStarting.httpStatus).toBe(409);
    expect('error' in deniedStarting.payload && deniedStarting.payload.error.code).toBe(
      'exposure_ack_required'
    );
    await starting.manager.stop();

    const degraded = await setup({ loginEnforced: () => false });
    dirs.push(degraded.dir);
    degraded.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      tunnelName: 'n',
    });
    degraded.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection connIndex=0\n',
    });
    await degraded.manager.handleAction({ action: 'start', acknowledgeExposure: true });
    await waitJob(degraded.manager);
    expect(degraded.manager.status().process.state).toBe('running');
    degraded.spawner.lastHandle()?.writeStdout('Unregistered tunnel connection connIndex=0\n');
    await waitState(degraded.manager, 'degraded');
    const deniedDegraded = await degraded.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(deniedDegraded.httpStatus).toBe(409);
    expect('error' in deniedDegraded.payload && deniedDegraded.payload.error.code).toBe(
      'exposure_ack_required'
    );
    await degraded.manager.stop();
  });

  test('set_access_mode none requires ack for a freshly detected running external tunnel', async () => {
    const ctx = await setup({
      loginEnforced: () => false,
      ackDetectMs: 80,
      externalDetectDeps: {
        listProcesses: async () => '9 cloudflared tunnel run --token-file /tmp/token\n',
        readFile: async (path) =>
          path === '/tmp/token'
            ? Buffer.from(JSON.stringify({ a: 'a', t: 'tid', s: 's' })).toString('base64')
            : path === '/tmp/hostname'
              ? 'ok.example.com\n'
              : null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      externallyManaged: true,
    });
    const denied = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(denied.httpStatus).toBe(409);
    expect('error' in denied.payload && denied.payload.error.code).toBe('exposure_ack_required');
    expect(ctx.manager.status().config.accessMode).toBeNull();
  });

  test('set_access_mode none is allowed without ack after a fresh stopped external detect', async () => {
    const ctx = await setup({
      loginEnforced: () => false,
      ackDetectMs: 80,
      externalDetectDeps: {
        listProcesses: async () => '',
        readFile: async () => null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      externallyManaged: true,
    });
    const result = await ctx.manager.handleAction({
      action: 'set_access_mode',
      accessMode: 'none',
    });
    expect(result.httpStatus).toBe(200);
    expect(ctx.manager.status().config.accessMode).toBe('none');
    expect(ctx.store.get().exposureAcknowledgedAt).toBeNull();
  });

  test('access status fallback does not share a mutable rules array', async () => {
    const ctx = await setup({
      accessStore: {
        get() {
          throw new Error('access store unavailable');
        },
        save: async () => {
          throw new Error('access store unavailable');
        },
        getApiToken: async () => null,
      },
    });
    dirs.push(ctx.dir);
    const first = ctx.manager.status().access;
    expect(first.rules).toEqual([]);
    first.rules.push({ kind: 'email', value: 'leaked@example.com' });
    expect(ctx.manager.status().access.rules).toEqual([]);
  });

  test('remove_access and set_access_enforce(false) require ack when tunnel is running unprotected', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => false,
      accessStore,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'ok.example.com', tunnelId: 'tid', tunnelName: 'n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'start' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.state).toBe('running');

    const enforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
    });
    expect(enforce.httpStatus).toBe(409);
    expect('error' in enforce.payload && enforce.payload.error.code).toBe('exposure_ack_required');

    const removed = await ctx.manager.handleAction({ action: 'remove_access' });
    expect(removed.httpStatus).toBe(409);

    const okEnforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
      acknowledgeExposure: true,
    });
    expect(okEnforce.httpStatus).toBe(200);
    expect(ctx.manager.status().access.enforceJwt).toBe(false);
  });

  test('remove_access and set_access_enforce(false) require ack when tunnel is degraded', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => false,
      accessStore,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'ok.example.com', tunnelId: 'tid', tunnelName: 'n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection connIndex=0\n',
    });
    await ctx.manager.handleAction({ action: 'start' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().process.state).toBe('running');
    ctx.spawner.lastHandle()?.writeStdout('Unregistered tunnel connection connIndex=0\n');
    await waitState(ctx.manager, 'degraded');

    const enforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
    });
    expect(enforce.httpStatus).toBe(409);
    expect('error' in enforce.payload && enforce.payload.error.code).toBe('exposure_ack_required');

    const removed = await ctx.manager.handleAction({ action: 'remove_access' });
    expect(removed.httpStatus).toBe(409);

    const okEnforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
      acknowledgeExposure: true,
    });
    expect(okEnforce.httpStatus).toBe(200);
    expect(ctx.manager.status().access.enforceJwt).toBe(false);
  });

  test('externally managed last-protection ack requires a fresh running detect', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => false,
      accessStore,
      ackDetectMs: 80,
      fetchImpl: async () => new Response(null, { status: 404 }),
      externalDetectDeps: {
        listProcesses: async () => '9 cloudflared tunnel run --token-file /tmp/token\n',
        readFile: async (path) =>
          path === '/tmp/token'
            ? Buffer.from(JSON.stringify({ a: 'a', t: 'tid', s: 's' })).toString('base64')
            : path === '/tmp/hostname'
              ? 'ok.example.com\n'
              : null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      externallyManaged: true,
    });
    const enforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
    });
    expect(enforce.httpStatus).toBe(409);
    expect('error' in enforce.payload && enforce.payload.error.code).toBe('exposure_ack_required');
  });

  test('externally managed last-protection ack is waived after fresh stopped detect', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => false,
      accessStore,
      ackDetectMs: 80,
      fetchImpl: async () => new Response(null, { status: 404 }),
      externalDetectDeps: {
        listProcesses: async () => '',
        readFile: async () => null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      externallyManaged: true,
    });
    const enforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
    });
    expect(enforce.httpStatus).toBe(200);
    expect(ctx.manager.status().access.enforceJwt).toBe(false);
  });

  test('externally managed last-protection ack is required when fresh detect times out', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
      appId: 'app',
      aud: 'aud',
      hostname: 'ok.example.com',
      rules: [{ kind: 'email', value: 'a@example.com' }],
      enforceJwt: true,
    });
    const ctx = await setup({
      loginEnforced: () => false,
      accessStore,
      ackDetectMs: 40,
      fetchImpl: async () => new Response(null, { status: 404 }),
      externalDetectDeps: {
        listProcesses: () => new Promise(() => {}),
        readFile: async () => null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({
      mode: 'named',
      hostname: 'ok.example.com',
      tunnelId: 'tid',
      externallyManaged: true,
    });
    const enforce = await ctx.manager.handleAction({
      action: 'set_access_enforce',
      enforceJwt: false,
    });
    expect(enforce.httpStatus).toBe(409);
    expect('error' in enforce.payload && enforce.payload.error.code).toBe('exposure_ack_required');
  });

  test('sync_access aborts when the Access app list is truncated', async () => {
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({
      accountId: 'acc',
      apiToken: 'tok',
      teamDomain: 'team.cloudflareaccess.com',
    });
    const ctx = await setup({
      accessStore,
      accessClient: {
        listApps: async () =>
          Object.assign([{ id: 'a', aud: 'b', name: 'x', domain: 'other.example.com' }], {
            truncated: true,
          }),
        findAppForHostname: () => null,
        findBypassApps: () => [],
      } as unknown as CloudflareAccessClient,
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com' });
    const queued = await ctx.manager.handleAction({ action: 'sync_access' });
    expect(queued.httpStatus).toBe(202);
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('error');
    expect(job?.error?.message).toMatch(/incomplete/i);
  });

  test('login succeeds when cert appears at default ~/.cloudflared/cert.pem and copies it', async () => {
    const ctx = await setup({ loginTimeoutMs: 2_000 });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, 'login'), {
      hold: true,
      stdout: 'https://dash.cloudflare.com/argotunnel\n',
    });
    await mkdir(join(ctx.homeDir, '.cloudflared'), { recursive: true });
    await ctx.manager.handleAction({ action: 'login' });
    const start = Date.now();
    while (Date.now() - start < 1_000 && !ctx.manager.status().auth.loginUrl) {
      await Bun.sleep(5);
    }
    await writeFile(join(ctx.homeDir, '.cloudflared', 'cert.pem'), 'DEFAULT-CERT', 'utf8');
    ctx.spawner.lastHandle()?.exit(0);
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(ctx.manager.status().auth.loggedIn).toBe(true);
    expect(await readFile(join(ctx.dir, 'cert.pem'), 'utf8')).toBe('DEFAULT-CERT');
    expect(await readFile(join(ctx.homeDir, '.cloudflared', 'cert.pem'), 'utf8')).toBe(
      'DEFAULT-CERT'
    );
    expect((await stat(join(ctx.dir, 'cert.pem'))).mode & 0o777).toBe(0o600);
  });

  test('create copies a pre-existing default cert into tunnelDir', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    await mkdir(join(ctx.homeDir, '.cloudflared'), { recursive: true });
    await writeFile(join(ctx.homeDir, '.cloudflared', 'cert.pem'), 'DEFAULT-CERT', 'utf8');
    expect(existsSync(join(ctx.dir, 'cert.pem'))).toBe(false);
    expect(ctx.manager.status().auth.loggedIn).toBe(true);
    ctx.spawner.once((s) => argsInclude(s, 'create'), {
      stdout: 'Created tunnel vibeterm-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
    });
    ctx.spawner.on((s) => argsInclude(s, 'dns'), { stdout: 'ok\n' });
    ctx.spawner.on((s) => argsInclude(s, 'run'), {
      hold: true,
      stdout: 'Registered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'create', hostname: 'remote.example.com' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(await readFile(join(ctx.dir, 'cert.pem'), 'utf8')).toBe('DEFAULT-CERT');
    expect(existsSync(join(ctx.homeDir, '.cloudflared', 'cert.pem'))).toBe(true);
  });

  test('detection credentials prefer accessStore over cert.pem and never persist the cert token', async () => {
    const ingressCalls: Array<{ accountId: string; token: string }> = [];
    const accessStore = new MemoryTunnelAccessStore();
    await accessStore.save({ apiToken: 'store-tok', accountId: 'store-acct' });
    const ctx = await setup({
      accessStore,
      accessClient: {
        getTunnelIngress: async (accountId: string, apiToken: string) => {
          ingressCalls.push({ accountId, token: apiToken });
          return [{ hostname: 'from-store.example.com', service: 'http://127.0.0.1:19883' }];
        },
        getTunnel: async () => ({ id: 'tid', name: 'named' }),
        listApps: async () => [],
      } as unknown as CloudflareAccessClient,
      externalDetectDeps: {
        listProcesses: async () => '7 cloudflared tunnel run --token-file /tmp/token\n',
        readFile: async (path) => {
          if (path === '/tmp/token') {
            return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
          }
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    await mkdir(join(ctx.homeDir, '.cloudflared'), { recursive: true });
    const pem = `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(
      JSON.stringify({ zoneID: 'z', accountID: 'cert-acct', apiToken: 'cert-tok' })
    ).toString('base64')}\n-----END ARGO TUNNEL TOKEN-----\n`;
    await writeFile(join(ctx.homeDir, '.cloudflared', 'cert.pem'), pem, 'utf8');
    await ctx.manager.refreshExternal();
    expect(ctx.manager.status().external.hostnames).toEqual(['from-store.example.com']);
    expect(ingressCalls).toEqual([{ accountId: 'acct', token: 'store-tok' }]);
    expect(JSON.stringify(ctx.manager.status())).not.toContain('store-tok');
    expect(JSON.stringify(ctx.manager.status())).not.toContain('cert-tok');
  });

  test('cert.pem ARGO token is a read-only fallback when accessStore is empty', async () => {
    const ingressCalls: Array<{ accountId: string; token: string }> = [];
    const ctx = await setup({
      accessClient: {
        getTunnelIngress: async (accountId: string, apiToken: string) => {
          ingressCalls.push({ accountId, token: apiToken });
          return [{ hostname: 'from-cert.example.com', service: 'http://127.0.0.1:19883' }];
        },
        getTunnel: async () => ({ id: 'tid', name: 'named' }),
        listApps: async () => [],
      } as unknown as CloudflareAccessClient,
      externalDetectDeps: {
        listProcesses: async () => '7 cloudflared tunnel run --token-file /tmp/token\n',
        readFile: async (path) => {
          if (path === '/tmp/token') {
            return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
          }
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    await mkdir(join(ctx.homeDir, '.cloudflared'), { recursive: true });
    const pem = `-----BEGIN ARGO TUNNEL TOKEN-----\n${Buffer.from(
      JSON.stringify({ zoneID: 'z', accountID: 'cert-acct', apiToken: 'cert-tok' })
    ).toString('base64')}\n-----END ARGO TUNNEL TOKEN-----\n`;
    await writeFile(join(ctx.homeDir, '.cloudflared', 'cert.pem'), pem, 'utf8');
    await ctx.manager.refreshExternal();
    expect(ctx.manager.status().external.hostnames).toEqual(['from-cert.example.com']);
    expect(ingressCalls).toEqual([{ accountId: 'acct', token: 'cert-tok' }]);
    expect(ctx.manager.status().access.hasCredentials).toBe(false);
  });

  test('adopt_external accepts a token-mode tunnel discovered via escaped log + sibling hostname', async () => {
    const inner = JSON.stringify({
      ingress: [
        { hostname: 'vibeterm.konata.tv', originRequest: {}, service: 'http://127.0.0.1:19883' },
        { service: 'http_status:404' },
      ],
      'warp-routing': { enabled: false },
    });
    const escapedLog = JSON.stringify({
      level: 'info',
      version: 1,
      config: inner,
      time: '2026-08-31T00:00:00Z',
      message: 'Updated to new configuration',
    });
    const ctx = await setup({
      loginEnforced: () => false,
      externalDetectDeps: {
        listProcesses: async () =>
          '1 cloudflared tunnel --logfile /tmp/cf.log --token-file /tmp/vibeterm-cf/token run\n',
        readFile: async (path) => {
          if (path === '/tmp/vibeterm-cf/token') {
            return Buffer.from(JSON.stringify({ a: 'a', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/vibeterm-cf/hostname') return 'vibeterm.konata.tv\n';
          if (path === '/tmp/vibeterm-cf/tunnel-id') return 'tid\n';
          if (path === '/tmp/cf.log') return `${escapedLog}\n`;
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    const adopt = await ctx.manager.handleAction({
      action: 'adopt_external',
      hostname: 'vibeterm.konata.tv',
    });
    expect(adopt.httpStatus).toBe(200);
    const status = ctx.manager.status();
    expect(status.config.externallyManaged).toBe(true);
    expect(status.config.hostname).toBe('vibeterm.konata.tv');
    expect(status.external.hostnames).toEqual(['vibeterm.konata.tv']);
  });

  test('start warms external detection without throwing on unsupported platform', async () => {
    const ctx = await setup({ platform: 'win32', arch: 'x64' });
    dirs.push(ctx.dir);
    await expect(ctx.manager.start()).resolves.toBeUndefined();
    expect(ctx.manager.status().supported).toBe(false);
  });

  test('start does not await a slow external detection', async () => {
    let finished = false;
    const ctx = await setup({
      externalDetectDeps: {
        listProcesses: async () => {
          await Bun.sleep(200);
          finished = true;
          return '';
        },
        readFile: async () => null,
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    const t0 = Date.now();
    await ctx.manager.start();
    expect(Date.now() - t0).toBeLessThan(150);
    expect(finished).toBe(false);
  });

  test('spawns cloudflared with --metrics from pickPort', async () => {
    const ctx = await setup({ pickPort: async () => 41234 });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://metrics-cloud.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const call = ctx.spawner.calls.find((c) => argsInclude(c, '--url'));
    expect(call?.args).toContain('--metrics');
    expect(call?.args).toContain('127.0.0.1:41234');
  });

  test('status is degraded when the connector reports zero edge connections', async () => {
    const ctx = await setup({
      pickPort: async () => 41234,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json(
            { status: 503, readyConnections: 0, connectorId: 'dead' },
            { status: 503 }
          );
        }
        return Response.json({ startedAt: 111 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://lucky-cloud-9.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    await waitState(ctx.manager, 'degraded');
    const status = ctx.manager.status();
    expect(status.process.state).toBe('degraded');
    expect(status.process.publicUrl).toBe('https://lucky-cloud-9.trycloudflare.com');
    expect(status.connector.reachable).toBe(true);
    expect(status.connector.readyConnections).toBe(0);
    await ctx.manager.stop();
  });

  test('check job fails connector_down for external Access 302 with zero edge connections', async () => {
    const ctx = await setup({
      pickPort: async () => 41234,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json(
            { status: 503, readyConnections: 0, connectorId: 'dead' },
            { status: 503 }
          );
        }
        return new Response(null, {
          status: 302,
          headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login' },
        });
      },
      externalDetectDeps: {
        listProcesses: async () =>
          '42 cloudflared tunnel --metrics 127.0.0.1:41234 --logfile /tmp/missing.log run --token-file /tmp/token\n',
        readFile: async (path) => {
          if (path === '/tmp/token') {
            return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/hostname') return 'remote.example.com\n';
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    const adopt = await ctx.manager.handleAction({
      action: 'adopt_external',
      hostname: 'remote.example.com',
    });
    expect(adopt.httpStatus).toBe(200);
    expect(ctx.manager.status().process.state).toBe('degraded');
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('error');
    expect(job?.error?.code).toBe('connector_down');
    expect(job?.step).toBe('connector_down');
  });

  test('check job is access_protected when Access 302 and connector has connections', async () => {
    const ctx = await setup({
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ status: 200, readyConnections: 4, connectorId: 'ok' });
        }
        return new Response(null, {
          status: 302,
          headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login' },
        });
      },
      externalDetectDeps: {
        listProcesses: async () =>
          '42 cloudflared tunnel --metrics 127.0.0.1:41234 run --token-file /tmp/token\n',
        readFile: async (path) => {
          if (path === '/tmp/token') {
            return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/hostname') return 'remote.example.com\n';
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'adopt_external',
      hostname: 'remote.example.com',
    });
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('access_protected');
    expect(ctx.manager.status().process.state).toBe('running');
  });

  test('check job is access_protected_unverified when Access 302 and metrics are missing', async () => {
    const ctx = await setup({
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login' },
        }),
      externalDetectDeps: {
        listProcesses: async () => '42 cloudflared tunnel run --token-file /tmp/token\n',
        readFile: async (path) => {
          if (path === '/tmp/token') {
            return Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/hostname') return 'remote.example.com\n';
          return null;
        },
        listDir: async () => [],
        homedir: () => '/no-home',
        platform: 'linux',
      },
    });
    dirs.push(ctx.dir);
    await ctx.manager.handleAction({
      action: 'adopt_external',
      hostname: 'remote.example.com',
    });
    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.state).toBe('done');
    expect(job?.step).toBe('access_protected_unverified');
  });

  test('status.log tails the external --logfile and redacts secrets', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const logPath = join(ctx.dir, 'cloudflared.log');
    const tokenPath = join(ctx.dir, 'token');
    const secret = 'c'.repeat(32);
    await writeFile(
      tokenPath,
      Buffer.from(JSON.stringify({ a: 'acct', t: 'tid', s: 's' })).toString('base64')
    );
    await writeFile(
      logPath,
      `INF hello\nERR TLS handshake ${secret}\nINF Registered tunnel connection connIndex=0\n`,
      'utf8'
    );
    const withLog = await setup({
      now: (() => {
        let t = 1_000;
        return () => t++;
      })(),
      externalDetectDeps: {
        listProcesses: async () =>
          `42 cloudflared tunnel --logfile ${logPath} run --token-file ${tokenPath}\n`,
        readFile: async (path) => {
          if (path === tokenPath) return await readFile(tokenPath, 'utf8');
          if (path === join(ctx.dir, 'hostname')) return 'remote.example.com\n';
          if (path === logPath) return await readFile(logPath, 'utf8');
          return null;
        },
        listDir: async () => [],
        homedir: () => ctx.dir,
        platform: 'linux',
      },
    });
    dirs.push(withLog.dir);
    await withLog.manager.handleAction({
      action: 'adopt_external',
      hostname: 'remote.example.com',
    });
    const log = withLog.manager.status().log.join('\n');
    expect(log).toContain('Registered tunnel connection');
    expect(log).toContain('***');
    expect(log).not.toContain(secret);
  });

  test('polls the connector while the tunnel is up using injected sleep', async () => {
    const sleeps: number[] = [];
    const readyAt: number[] = [];
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      sleep: async (ms) => {
        sleeps.push(ms);
        await Bun.sleep(1);
      },
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          readyAt.push(Date.now());
          return Response.json({ readyConnections: 4, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://poll-cloud.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const start = Date.now();
    while (Date.now() - start < 1_000 && readyAt.length < 2) {
      await Bun.sleep(5);
    }
    expect(sleeps).toContain(30_000);
    expect(readyAt.length).toBeGreaterThanOrEqual(2);
    await ctx.manager.stop();
  });

  test('slow connector probe resolving after stop does not overwrite EMPTY_CONNECTOR', async () => {
    const hanging = Promise.withResolvers<void>();
    let hangReady = false;
    const ctx = await setup({
      pickPort: async () => 41234,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          if (hangReady) await hanging.promise;
          return Response.json({ readyConnections: 4, connectorId: 'stale' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://stale-cloud.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().connector.connectorId).toBe('stale');

    hangReady = true;
    const slow = ctx.manager.probeAndStoreConnector();
    await Bun.sleep(20);
    await ctx.manager.handleAction({ action: 'stop' });
    await waitJob(ctx.manager);
    expect(ctx.manager.status().connector).toEqual({
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
    });
    hanging.resolve();
    await slow;
    expect(ctx.manager.status().connector).toEqual({
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
    });
  });
});

describe('TunnelManager edge resolution', () => {
  const systemEdge = (lastError: string | null) => ({
    mode: 'system' as const,
    fakeIpDetected: true,
    edgeAddrs: [] as string[],
    checkedAt: '2026-09-05T00:00:00.000Z',
    lastError,
  });
  const staticEdge = {
    mode: 'static' as const,
    fakeIpDetected: true,
    edgeAddrs: ['198.41.192.7:7844'],
    checkedAt: '2026-09-05T00:01:00.000Z',
    lastError: null,
  };

  test('status exposes the edge resolution and check reports the fake-IP hijack', async () => {
    const ctx = await setup({
      pickPort: async () => 41234,
      resolveEdge: async () => systemEdge('DoH edge resolution failed: HTTP 500'),
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://edge-cloud.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const status = ctx.manager.status();
    expect(status.edge).toMatchObject({ mode: 'system', fakeIpDetected: true });
    expect(status.process.state).toBe('degraded');

    await ctx.manager.handleAction({ action: 'check' });
    const job = await waitJob(ctx.manager);
    expect(job?.error?.code).toBe('connector_down');
    expect(job?.error?.message).toContain('fake-IP 198.18.x');
    expect(job?.error?.message).toContain('static edge override failed');
    await ctx.manager.stop();
    expect(ctx.manager.status().edge).toBeNull();
  });

  test('restarts once with a static edge list after staying at zero connections', async () => {
    const resolutions = [systemEdge(null), systemEdge(null), staticEdge, staticEdge];
    let resolved = 0;
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      edgeRecoveryDelayMs: 0,
      sleep: async (ms) => {
        await Bun.sleep(Math.min(ms, 1));
      },
      resolveEdge: async () => resolutions[Math.min(resolved++, resolutions.length - 1)] ?? null,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://edge-restart.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);
    const firstRun = ctx.spawner.calls.find((c) => argsInclude(c, '--url'));
    expect(firstRun?.args).not.toContain('--edge');

    const start = Date.now();
    while (Date.now() - start < 2_000) {
      if (ctx.spawner.calls.some((c) => argsInclude(c, '--edge'))) break;
      await Bun.sleep(5);
    }
    const withEdge = ctx.spawner.calls.filter((c) => argsInclude(c, '--edge'));
    expect(withEdge.length).toBe(1);
    expect(withEdge[0]?.args).toContain('198.41.192.7:7844');
    expect(ctx.manager.status().edge).toMatchObject({ mode: 'static' });

    await Bun.sleep(60);
    expect(ctx.spawner.calls.filter((c) => argsInclude(c, '--edge')).length).toBe(1);
    await ctx.manager.stop();
  });

  test('reuses the recovery resolution even when the provider cannot resolve again', async () => {
    let resolved = 0;
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      edgeRecoveryDelayMs: 0,
      sleep: async (ms) => {
        await Bun.sleep(Math.min(ms, 1));
      },
      resolveEdge: async () => {
        resolved += 1;
        if (resolved === 1) return systemEdge(null);
        if (resolved === 2) return staticEdge;
        throw new Error('DoH flapped');
      },
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://edge-reuse.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);

    const start = Date.now();
    while (Date.now() - start < 2_000) {
      if (ctx.spawner.calls.some((c) => argsInclude(c, '--edge'))) break;
      await Bun.sleep(5);
    }
    const withEdge = ctx.spawner.calls.filter((c) => argsInclude(c, '--edge'));
    expect(withEdge.length).toBe(1);
    expect(withEdge[0]?.args).toContain('198.41.192.7:7844');
    expect(ctx.manager.status().edge).toMatchObject({ mode: 'static' });
    await ctx.manager.stop();
  });

  test('a stop while the recovery resolution is pending does not restart the tunnel', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    let resolved = 0;
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      edgeRecoveryDelayMs: 0,
      sleep: async (ms) => {
        await Bun.sleep(Math.min(ms, 1));
      },
      resolveEdge: async () => {
        resolved += 1;
        if (resolved === 1) return systemEdge(null);
        if (resolved === 2) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return staticEdge;
      },
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.spawner.on((s) => argsInclude(s, '--url'), {
      hold: true,
      stdout: 'https://edge-stop.trycloudflare.com\nRegistered tunnel connection\n',
    });
    await ctx.manager.handleAction({ action: 'quick_start' });
    await waitJob(ctx.manager);

    const start = Date.now();
    while (Date.now() - start < 2_000 && !gate.release) await Bun.sleep(5);
    expect(gate.release).not.toBeNull();

    const runsBefore = ctx.spawner.calls.filter((c) => argsInclude(c, '--url')).length;
    await ctx.manager.stop();
    gate.release?.();
    await Bun.sleep(80);
    expect(ctx.spawner.calls.filter((c) => argsInclude(c, '--url')).length).toBe(runsBefore);
    expect(ctx.spawner.calls.some((c) => argsInclude(c, '--edge'))).toBe(false);
    expect(ctx.manager.status().process.state).not.toBe('running');
  });

  test('auto-start at boot polls the connector even when cloudflared never registers', async () => {
    const readyAt: number[] = [];
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      runningWaitMs: 20,
      // 轮询间隔要比注册超时慢：先让启动失败落定，再看轮询是否仍然继续
      sleep: async (ms) => {
        await Bun.sleep(ms >= 30_000 ? 40 : 1);
      },
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          readyAt.push(Date.now());
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com', autoStart: true });
    // 没有 Registered 行：fake-IP 环境下 cloudflared 起来了却永远 0 连接
    ctx.spawner.on((s) => argsInclude(s, 'run'), { hold: true });
    await ctx.manager.start();
    expect(ctx.spawner.calls.some((c) => argsInclude(c, 'run'))).toBe(true);
    expect(ctx.manager.status().process.state).toBe('error');

    const before = readyAt.length;
    const start = Date.now();
    while (Date.now() - start < 1_500 && readyAt.length < before + 3) await Bun.sleep(5);
    expect(readyAt.length).toBeGreaterThanOrEqual(before + 3);
    await ctx.manager.stop();
  });

  test('an auto-started tunnel that never registers is recovered with a static edge', async () => {
    const warnings: string[] = [];
    const resolutions = [
      systemEdge(null),
      systemEdge('DoH edge resolution failed: HTTP 500'),
      staticEdge,
    ];
    let resolved = 0;
    let clock = Date.parse('2026-09-05T00:00:00.000Z');
    const ctx = await setup({
      pickPort: async () => 41234,
      connectorPollMs: 30_000,
      edgeRecoveryDelayMs: 90_000,
      runningWaitMs: 20,
      now: () => {
        clock += 1;
        return clock;
      },
      sleep: async (ms) => {
        clock += ms;
        await Bun.sleep(ms >= 30_000 ? 40 : 1);
      },
      warn: (message) => warnings.push(message),
      resolveEdge: async () => resolutions[Math.min(resolved++, resolutions.length - 1)] ?? null,
      fetchImpl: async (input) => {
        if (String(input).includes('/ready')) {
          return Response.json({ readyConnections: 0, connectorId: 'c' });
        }
        return new Response(null, { status: 404 });
      },
    });
    dirs.push(ctx.dir);
    ctx.store.save({ mode: 'named', hostname: 'remote.example.com', autoStart: true });
    ctx.spawner.on((s) => argsInclude(s, 'run'), { hold: true });
    await ctx.manager.start();
    expect(ctx.spawner.calls.filter((c) => argsInclude(c, 'run')).length).toBe(1);
    expect(ctx.spawner.calls.some((c) => argsInclude(c, '--edge'))).toBe(false);
    expect(ctx.manager.status().process.state).toBe('error');

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      if (ctx.spawner.calls.some((c) => argsInclude(c, '--edge'))) break;
      await Bun.sleep(5);
    }
    const withEdge = ctx.spawner.calls.filter((c) => argsInclude(c, '--edge'));
    expect(withEdge.length).toBe(1);
    expect(withEdge[0]?.args).toContain('198.41.192.7:7844');
    expect(withEdge[0]?.args.join(' ')).toContain('--protocol http2');
    expect(ctx.manager.status().edge).toMatchObject({ mode: 'static' });

    await Bun.sleep(150);
    expect(ctx.spawner.calls.filter((c) => argsInclude(c, '--edge')).length).toBe(1);
    const recoveryLogs = warnings.filter((w) => w.includes('edge recovery attempt='));
    expect(recoveryLogs.length).toBeGreaterThanOrEqual(2);
    expect(recoveryLogs[0]).toContain('attempt=1 result=system');
    expect(recoveryLogs[0]).toContain('error=DoH edge resolution failed: HTTP 500');
    expect(recoveryLogs[1]).toContain('attempt=2 result=static');
    await ctx.manager.stop();
  });
});
