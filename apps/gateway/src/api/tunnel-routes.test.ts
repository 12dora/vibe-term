import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TunnelStatusResponse } from '@tmex/shared';
import { MESH_VIA_SELF, requestDispatchContext, setMeshRequestContext } from '../mesh/mesh-deps';
import { MemoryTunnelConfigStore } from '../tunnel/config-store';
import { FakeSpawner, argsInclude } from '../tunnel/fake-spawn';
import { TunnelManager } from '../tunnel/manager';
import { dispatchRoutes } from './route';
import { createTunnelRoutes } from './tunnel-routes';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tmex-tun-rt-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'tmex-tun-rt-home-'));
  const spawner = new FakeSpawner();
  spawner.on((s) => argsInclude(s, '--version'), {
    stdout: 'cloudflared version 2025.8.1\n',
  });
  spawner.on((s) => argsInclude(s, 'login'), {
    hold: true,
    stdout: 'https://dash.cloudflare.com/argotunnel\n',
  });
  const manager = new TunnelManager({
    tunnelDir: dir,
    homeDir,
    originPort: 19883,
    platform: 'linux',
    arch: 'x64',
    store: new MemoryTunnelConfigStore(),
    spawner: spawner.spawn,
    which: () => '/usr/bin/cloudflared',
    downloader: async (_url, dest) => {
      await Bun.write(dest, 'x');
    },
    sleep: (ms) => Bun.sleep(Math.min(ms, 5)),
    loginTimeoutMs: 5_000,
    loginPollMs: 20,
    runningWaitMs: 400,
    trustProxy: false,
    loginEnforced: () => true,
    registerAccessGuard: false,
    externalDetectDeps: {
      listProcesses: async () => '',
      readFile: async () => null,
      listDir: async () => [],
      homedir: () => homeDir,
      platform: 'linux',
    },
  });
  managers.push(manager);
  dirs.push(homeDir);
  return { dir, homeDir, manager, routes: createTunnelRoutes(manager) };
}

const dirs: string[] = [];
const managers: TunnelManager[] = [];
afterEach(async () => {
  while (managers.length) {
    await managers.pop()?.stop();
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function dispatch(
  routes: ReturnType<typeof createTunnelRoutes>,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const request = req(method, path, body);
  const result = dispatchRoutes(request, path, routes, { path });
  if (!result) throw new Error('no route');
  return result;
}

describe('tunnel routes', () => {
  test('GET /api/tunnel/status returns the contract shape', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'GET', '/api/tunnel/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as TunnelStatusResponse;
    expect(body.supported).toBe(true);
    expect(body.platform).toBe('linux-x64');
    expect(body.binary).toMatchObject({ installed: true, source: 'system' });
    expect(body.auth).toMatchObject({ loggedIn: false, loginUrl: null });
    expect(body.config).toMatchObject({
      mode: 'off',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
      autoStart: false,
      originPort: 19883,
    });
    expect(body.process).toMatchObject({
      state: 'stopped',
      pid: null,
      publicUrl: null,
      restarts: 0,
    });
    expect(body.job).toBeNull();
    expect(body.trustProxy).toBe(false);
    expect(body.configuredTrustProxy).toBe(false);
    expect(body.restartRequired).toBe(false);
    expect(body.loginEnforced).toBe(true);
    expect(body.exposureProtected).toBe(true);
    expect(body.access).toMatchObject({
      hasCredentials: false,
      configured: false,
      enforceJwt: false,
      rules: [],
    });
    expect(body.external).toMatchObject({
      detected: false,
      externalAccess: {
        checked: false,
        hostnameMatch: false,
        appId: null,
        aud: null,
        teamDomain: null,
      },
    });
    expect(body.config.externallyManaged).toBe(false);
    expect(Array.isArray(body.log)).toBe(true);
  });

  test('POST create with invalid hostname is 400', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', {
      action: 'create',
      hostname: 'NOT A HOST',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'invalid_hostname', message: 'hostname is not a valid RFC 1123 name' },
    });
  });

  test('POST create without hostname is 400 invalid_request', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', { action: 'create' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('second job while one is running returns 409 busy', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const login = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', { action: 'login' });
    expect(login.status).toBe(202);
    const busy = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', { action: 'install' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      error: { code: 'busy', message: 'A tunnel job is already running' },
    });
    await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', { action: 'cancel_login' });
    await ctx.manager.stop();
  });

  test('POST create with traversal tunnelName is 400', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    for (const tunnelName of ['../../x', '/abs', 'foo\nbar', 'a'.repeat(64)]) {
      const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', {
        action: 'create',
        hostname: 'ok.example.com',
        tunnelName,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    }
  });

  test('POST exposing actions return 409 exposure_ack_required when unprotected', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    ctx.manager.setLoginEnforced(() => false);
    const expected = {
      error: {
        code: 'exposure_ack_required',
        message:
          'This instance has no sign-in and no Cloudflare Access protection; confirm public exposure explicitly',
      },
    };
    for (const body of [
      { action: 'quick_start' },
      { action: 'create', hostname: 'ok.example.com' },
      { action: 'start' },
      { action: 'set_auto_start', autoStart: true },
    ]) {
      const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual(expected);
    }
  });

  test('POST configure_access with invalid hostname is 400', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', {
      action: 'configure_access',
      hostname: 'NOT A HOST',
      rules: [{ kind: 'email', value: 'a@example.com' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_hostname');
  });

  test('POST configure_access without rules is 400', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', {
      action: 'configure_access',
      rules: [],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
  });

  test('POST set_access_credentials without token is 400', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);
    const res = await dispatch(ctx.routes, 'POST', '/api/tunnel/actions', {
      action: 'set_access_credentials',
      accountId: 'acc',
    });
    expect(res.status).toBe(400);
  });

  test('peer-forwarded /api/tunnel requests return 404', async () => {
    const ctx = await setup();
    dirs.push(ctx.dir);

    const forwarded = req('GET', '/api/tunnel/status');
    requestDispatchContext.set(forwarded, { uid: 'user-1', viaNodeId: 'remote-node' });
    const forwardedRes = dispatchRoutes(forwarded, '/api/tunnel/status', ctx.routes, {
      path: '/api/tunnel/status',
    });
    if (!forwardedRes) throw new Error('no route');
    expect((await forwardedRes).status).toBe(404);

    const peer = req('POST', '/api/tunnel/actions', { action: 'check' });
    setMeshRequestContext(peer, { via: 'peer-a', clientIp: 'peer:peer-a' });
    const peerRes = dispatchRoutes(peer, '/api/tunnel/actions', ctx.routes, {
      path: '/api/tunnel/actions',
    });
    if (!peerRes) throw new Error('no route');
    expect((await peerRes).status).toBe(404);

    const local = req('GET', '/api/tunnel/status');
    requestDispatchContext.set(local, { uid: 'user-1', viaNodeId: MESH_VIA_SELF });
    const localRes = dispatchRoutes(local, '/api/tunnel/status', ctx.routes, {
      path: '/api/tunnel/status',
    });
    if (!localRes) throw new Error('no route');
    expect((await localRes).status).toBe(200);
  });
});
