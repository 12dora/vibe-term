import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthError, UsageError } from '../core/errors';
import { TokenStore } from '../core/token-store';
import { ENTRY, NODE, jsonResponse, routeFetch, testContext } from './cli-test-harness';
import { parseExpiresDays, command as token } from './token';

const ENTRY_NODE = 'f'.repeat(32);
const SECRET = 'vtk_abcdefghijklmnopqrstuvwxyz012345678901234';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function dto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tok-1',
    name: 'agent',
    scopes: ['exec'],
    createdAt: Date.UTC(2026, 9, 1, 8, 30),
    expiresAt: Date.UTC(2027, 0, 1, 0, 0),
    lastUsedAt: null,
    lastUsedIp: null,
    ...overrides,
  };
}

const MODE = { 'GET /api/auth/mode': () => ({ mode: 'password', nodeId: ENTRY_NODE }) };

async function setup(routes: Parameters<typeof routeFetch>[0], json = false) {
  const built = await testContext(routeFetch({ ...MODE, ...routes }), { json });
  dirs.push(built.dir);
  return { ...built, reopen: () => TokenStore.open(built.dir, {}) };
}

describe('parseExpiresDays', () => {
  test('accepts Nd, Ny and never; rejects the rest', () => {
    expect(parseExpiresDays('30d')).toBe(30);
    expect(parseExpiresDays('90D')).toBe(90);
    expect(parseExpiresDays('1y')).toBe(365);
    expect(parseExpiresDays('never')).toBeNull();
    for (const bad of ['0d', '4000d', '11y', '30', 'soon', '']) {
      expect(() => parseExpiresDays(bad)).toThrow(UsageError);
    }
  });
});

describe('vibeterm token create', () => {
  test('defaults to exec / 90d, stores under self and the entry mesh id', async () => {
    let body: unknown;
    const { ctx, stdout, reopen } = await setup({
      'POST /api/auth/tokens': (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({ token: dto(), secret: SECRET }, 201);
      },
    });
    await token.run(ctx, ['create', '--name', 'agent']);

    expect(body).toEqual({ name: 'agent', scopes: ['exec'], expiresInDays: 90 });
    expect(stdout.text().trim()).toBe('已为 self 创建令牌 agent（exec，有效期 90 天）并保存');
    expect(stdout.text()).not.toContain(SECRET);
    const store = reopen();
    expect(store.get(ENTRY, 'self')?.secret).toBe(SECRET);
    expect(store.get(ENTRY, ENTRY_NODE)?.tokenId).toBe('tok-1');
    expect(store.get(ENTRY, NODE)).toBeNull();
  });

  test('targets a remote node by id and stores under that node only', async () => {
    let path = '';
    const { ctx, stdout, reopen } = await setup({
      'GET /api/mesh/nodes': () => ({ nodes: [] }),
      [`POST /n/${NODE}/api/auth/tokens`]: (url) => {
        path = url.pathname;
        return jsonResponse({ token: dto({ scopes: ['exec', 'files'] }), secret: SECRET }, 201);
      },
    });
    await token.run(ctx, [
      'create',
      NODE,
      '--name',
      'agent',
      '--scope',
      'exec,files',
      '--expires',
      'never',
    ]);

    expect(path).toBe(`/n/${NODE}/api/auth/tokens`);
    expect(stdout.text()).toContain(`已为 ${NODE} 创建令牌 agent（exec,files，永不过期）并保存`);
    const store = reopen();
    expect(store.get(ENTRY, NODE)?.scopes).toEqual(['exec', 'files']);
    expect(store.get(ENTRY, 'self')).toBeNull();
  });

  test('--no-save prints only the secret and writes nothing', async () => {
    const { ctx, stdout, stderr, dir } = await setup({
      'POST /api/auth/tokens': () => jsonResponse({ token: dto(), secret: SECRET }, 201),
    });
    await token.run(ctx, ['create', '--name', 'ci', '--no-save']);

    expect(stdout.text()).toBe(`${SECRET}\n`);
    expect(stderr.text()).toContain('未保存');
    expect(existsSync(join(dir, 'tokens.json'))).toBe(false);
  });

  test('--print saves and prints only the secret on stdout', async () => {
    const { ctx, stdout, stderr, reopen } = await setup({
      'POST /api/auth/tokens': () => jsonResponse({ token: dto(), secret: SECRET }, 201),
    });
    await token.run(ctx, ['create', '--name', 'ci', '--print']);

    expect(stdout.text()).toBe(`${SECRET}\n`);
    expect(stderr.text()).toContain('并保存');
    expect(reopen().get(ENTRY, 'self')?.secret).toBe(SECRET);
  });

  test('--json prints the DTO and only includes the secret when it is printed', async () => {
    const routes = {
      'POST /api/auth/tokens': () => jsonResponse({ token: dto(), secret: SECRET }, 201),
    };
    const plain = await setup(routes, true);
    await token.run(plain.ctx, ['create', '--name', 'agent']);
    const plainOut = JSON.parse(plain.stdout.text());
    expect(plainOut.token.id).toBe('tok-1');
    expect(plainOut.saved).toBe(true);
    expect(plainOut.secret).toBeUndefined();

    const printed = await setup(routes, true);
    await token.run(printed.ctx, ['create', '--name', 'agent', '--no-save']);
    const printedOut = JSON.parse(printed.stdout.text());
    expect(printedOut.secret).toBe(SECRET);
    expect(printedOut.saved).toBe(false);
  });

  test('rejects bad input before calling the server', async () => {
    const { ctx } = await setup({});
    await expect(token.run(ctx, ['create'])).rejects.toBeInstanceOf(UsageError);
    await expect(
      token.run(ctx, ['create', '--name', 'a', '--scope', 'root'])
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      token.run(ctx, ['create', '--name', 'a', '--expires', 'soon'])
    ).rejects.toBeInstanceOf(UsageError);
    await expect(
      token.run(ctx, ['create', '--name', 'a', '--print', '--no-save'])
    ).rejects.toBeInstanceOf(UsageError);
  });

  test('a token caller (TOKEN_SCOPE) is told to log in', async () => {
    const { ctx } = await setup({
      'POST /api/auth/tokens': () => jsonResponse({ code: 'TOKEN_SCOPE' }, 403),
    });
    const error = (await token
      .run(ctx, ['create', '--name', 'a'])
      .catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toBe('管理令牌需要先登录：vibeterm login');
  });

  test('TOKEN_SCOPE on a remote node points at login --node', async () => {
    const { ctx } = await setup({
      'GET /api/mesh/nodes': () => ({ nodes: [] }),
      [`GET /n/${NODE}/api/auth/tokens`]: () => jsonResponse({ code: 'TOKEN_SCOPE' }, 403),
    });
    const error = (await token.run(ctx, ['ls', NODE]).catch((err) => err)) as AuthError;
    expect(error.message).toBe(`管理令牌需要先登录：vibeterm login --node ${NODE}`);
  });

  test('no credentials at all stays the regular login-required error', async () => {
    const { ctx } = await setup({
      'POST /api/auth/tokens': () => jsonResponse({ code: 'UNAUTHORIZED' }, 401),
    });
    const error = (await token
      .run(ctx, ['create', '--name', 'a'])
      .catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.hint).toContain('vibeterm login');
  });
});

describe('vibeterm token ls / rm', () => {
  test('ls prints the table and marks tokens this CLI holds the secret for', async () => {
    const { ctx, stdout } = await setup({
      'GET /api/auth/tokens': () => ({
        tokens: [
          dto(),
          dto({
            id: 'tok-2',
            name: 'web',
            scopes: ['files', 'forward'],
            expiresAt: null,
            lastUsedAt: Date.UTC(2026, 9, 2, 1, 5),
          }),
        ],
      }),
    });
    ctx.tokens.put(ENTRY, ['self'], {
      tokenId: 'tok-1',
      secret: SECRET,
      name: 'agent',
      scopes: ['exec'],
      expiresAt: null,
      createdAt: 1,
    });
    await token.run(ctx, ['ls']);

    const lines = stdout.text().trimEnd().split('\n');
    expect(lines[0].split(/\s{2,}/)).toEqual([
      'ID',
      'NAME',
      'SCOPES',
      'CREATED',
      'LAST USED',
      'EXPIRES',
      'SAVED',
    ]);
    expect(lines[1].split(/\s{2,}/)).toEqual([
      'tok-1',
      'agent',
      'exec',
      '2026-10-01 08:30',
      '-',
      '2027-01-01 00:00',
      'yes',
    ]);
    expect(lines[2].split(/\s{2,}/)).toEqual([
      'tok-2',
      'web',
      'files,forward',
      '2026-10-01 08:30',
      '2026-10-02 01:05',
      'never',
      'no',
    ]);
  });

  test('ls --json returns the DTOs with a saved flag', async () => {
    const { ctx, stdout } = await setup(
      { 'GET /api/auth/tokens': () => ({ tokens: [dto()] }) },
      true
    );
    await token.run(ctx, ['ls']);
    const out = JSON.parse(stdout.text());
    expect(out.tokens[0]).toMatchObject({ id: 'tok-1', name: 'agent', saved: false });
  });

  test('rm by name revokes remotely and drops the saved copy', async () => {
    const deleted: string[] = [];
    const { ctx, stdout, reopen } = await setup({
      'GET /api/auth/tokens': () => ({ tokens: [dto(), dto({ id: 'tok-2', name: 'other' })] }),
      'DELETE /api/auth/tokens/tok-1': (url) => {
        deleted.push(url.pathname);
        return new Response(null, { status: 204 });
      },
    });
    ctx.tokens.put(ENTRY, ['self', ENTRY_NODE], {
      tokenId: 'tok-1',
      secret: SECRET,
      name: 'agent',
      scopes: ['exec'],
      expiresAt: null,
      createdAt: 1,
    });
    ctx.tokens.save();
    await token.run(ctx, ['rm', 'agent']);

    expect(deleted).toEqual(['/api/auth/tokens/tok-1']);
    expect(stdout.text()).toContain('已吊销 self 上的令牌 agent');
    const store = reopen();
    expect(store.get(ENTRY, 'self')).toBeNull();
    expect(store.get(ENTRY, ENTRY_NODE)).toBeNull();
  });

  test('rm by id on a remote node uses that node path', async () => {
    const deleted: string[] = [];
    const { ctx } = await setup({
      'GET /api/mesh/nodes': () => ({ nodes: [] }),
      [`GET /n/${NODE}/api/auth/tokens`]: () => ({ tokens: [dto()] }),
      [`DELETE /n/${NODE}/api/auth/tokens/tok-1`]: (url) => {
        deleted.push(url.pathname);
        return new Response(null, { status: 204 });
      },
    });
    await token.run(ctx, ['rm', NODE, 'tok-1']);
    expect(deleted).toEqual([`/n/${NODE}/api/auth/tokens/tok-1`]);
  });

  test('rm rejects unknown and ambiguous references without deleting', async () => {
    let deletes = 0;
    const { ctx } = await setup({
      'GET /api/auth/tokens': () => ({ tokens: [dto(), dto({ id: 'tok-2' })] }),
      'DELETE /api/auth/tokens/tok-1': () => {
        deletes += 1;
        return new Response(null, { status: 204 });
      },
    });
    await expect(token.run(ctx, ['rm', 'nope'])).rejects.toBeInstanceOf(UsageError);
    await expect(token.run(ctx, ['rm', 'agent'])).rejects.toBeInstanceOf(UsageError);
    await expect(token.run(ctx, ['rm'])).rejects.toBeInstanceOf(UsageError);
    expect(deletes).toBe(0);
  });
});

describe('vibeterm token add', () => {
  test('verifies with only the token cookie, then stores it', async () => {
    let cookie: string | null = null;
    const { ctx, stdout, reopen } = await setup({
      'GET /api/devices': (_url, init) => {
        cookie = new Headers(init?.headers).get('cookie');
        return { devices: [] };
      },
    });
    ctx.http.jar.set('self', 'sid-self', 0);
    await token.run(ctx, ['add', 'self', SECRET]);

    expect(cookie).toBe(`vibeterm_t_self=${SECRET}`);
    expect(stdout.text()).toContain('已保存 self 的令牌');
    const store = reopen();
    expect(store.get(ENTRY, 'self')?.secret).toBe(SECRET);
    expect(store.get(ENTRY, ENTRY_NODE)?.secret).toBe(SECRET);
  });

  test('a remote node is verified and stored under its own id', async () => {
    let cookie: string | null = null;
    const { ctx, reopen } = await setup({
      'GET /api/mesh/nodes': () => ({ nodes: [] }),
      [`GET /n/${NODE}/api/devices`]: (_url, init) => {
        cookie = new Headers(init?.headers).get('cookie');
        return { devices: [] };
      },
    });
    await token.run(ctx, ['add', NODE, SECRET]);
    expect(cookie).toBe(`vibeterm_t_${NODE}=${SECRET}`);
    expect(reopen().get(ENTRY, NODE)?.secret).toBe(SECRET);
  });

  test('a rejected token is an auth error and nothing is stored', async () => {
    const { ctx, dir } = await setup({
      'GET /api/devices': () => jsonResponse({ code: 'UNAUTHORIZED' }, 401),
    });
    const error = (await token.run(ctx, ['add', 'self', SECRET]).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).toContain('令牌无效');
    expect(existsSync(join(dir, 'tokens.json'))).toBe(false);
  });

  test('a secret without the vtk_ prefix is a usage error', async () => {
    const { ctx } = await setup({});
    await expect(token.run(ctx, ['add', 'self', 'hunter2'])).rejects.toBeInstanceOf(UsageError);
    await expect(token.run(ctx, ['add'])).rejects.toBeInstanceOf(UsageError);
  });
});
