import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const dir = await mkdtemp(join(tmpdir(), 'tmex-tun-'));
  const spawner = new FakeSpawner();
  spawner.on((s) => argsInclude(s, '--version'), {
    stdout: 'cloudflared version 2025.8.1 (built 2025-08-01T00:00:00Z)\n',
  });
  const store = new MemoryTunnelConfigStore();
  const manager = new TunnelManager({
    tunnelDir: dir,
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
      homedir: () => '/no-home',
      platform: 'linux',
    },
    ...overrides,
  });
  return { dir, spawner, store, manager };
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
        'Tunnel credentials written to /tmp/x.json\nCreated tunnel tmex-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
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
    expect(ctx.manager.status().config.tunnelName).toBe('tmex-remote');
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
      stdout: JSON.stringify([{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'tmex-remote' }]),
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
      stdout: 'Created tunnel tmex-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
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
        expect(String(input)).toBe('https://lucky-cloud-9.trycloudflare.com/healthz');
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
    expect(job?.step).not.toBe('check');
  });

  test('clears publicUrl on quick start/stop and does not leak named hostnames', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    ctx.spawner.once((s) => argsInclude(s, 'create'), {
      stdout: 'Created tunnel tmex-remote with id 550e8400-e29b-41d4-a716-446655440000\n',
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

  test('configure_access creates app, replaces policy, and enables JWT', async () => {
    const calls: string[] = [];
    const ctx = await setup({
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url}`);
        if (url.includes('/access/organizations')) {
          return Response.json({
            success: true,
            result: { auth_domain: 'acme.cloudflareaccess.com' },
          });
        }
        if (url.endsWith('/access/apps') && method === 'POST') {
          return Response.json({
            success: true,
            result: { id: 'app-1', aud: 'aud-1', domain: 'remote.example.com', name: 'tmex' },
          });
        }
        if (url.includes('/access/apps/app-1/policies') && method === 'GET') {
          return Response.json({ success: true, result: [] });
        }
        if (url.includes('/access/apps/app-1/policies') && method === 'POST') {
          return Response.json({ success: true, result: { id: 'pol-1' } });
        }
        if (url.endsWith('/access/apps/app-1') && method === 'GET') {
          return Response.json({
            success: true,
            result: { id: 'app-1', aud: 'aud-1', domain: 'remote.example.com', name: 'tmex' },
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
        listProcesses: async () => '  1 cloudflared tunnel --token-file /tmp/tok run\n',
        readFile: async (path) => {
          if (path === '/tmp/tok') {
            return Buffer.from(JSON.stringify({ a: 'a', t: 'tid', s: 's' })).toString('base64');
          }
          if (path === '/tmp/hostname') return 'ext.example.com';
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
    expect(ctx.manager.status().access.lastError).toBe('Invalid API Token');

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
            result: [{ id: 'app-9', aud: 'aud-9', domain: 'remote.example.com', name: 'tmex' }],
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
  });
});
