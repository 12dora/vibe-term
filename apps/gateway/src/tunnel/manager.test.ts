import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  test('refuses public exposure when login is not enforced', async () => {
    const ctx = await setup({ loginEnforced: () => false });
    dirs.push(ctx.dir);
    await writeFile(join(ctx.dir, 'cert.pem'), 'CERT', 'utf8');
    const expected = {
      code: 'auth_required' as const,
      message: 'Sign-in must be enabled before exposing tmex publicly',
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
    const disable = await ctx.manager.handleAction({ action: 'set_auto_start', autoStart: false });
    expect(disable.httpStatus).toBe(200);
    expect(ctx.manager.status().config.autoStart).toBe(false);
  });

  test('skips auto-start at boot when login is not enforced', async () => {
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
    expect(warnings.some((w) => /sign-in must be enabled/i.test(w))).toBe(true);
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
});
