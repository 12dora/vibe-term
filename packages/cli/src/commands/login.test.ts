import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { decodeBase64url, encodeBase64url, generateEd25519KeyPair } from '@vibeterm/shared/auth';
import { buildContext } from '../core/context';
import { AuthError, NetworkError, UsageError } from '../core/errors';
import type { FetchLike } from '../core/http';
import { type FakeGateway, createFakeGateway, createFakeUser } from '../core/test-fakes';
import { command as login } from './login';
import { command as logout } from './logout';
import { command as whoami } from './whoami';

const ENTRY = 'http://entry.example:9883';
const NODE_A = 'a'.repeat(32);
const NODE_HOME = 'b'.repeat(32);
const NODE_OFFLINE = 'c'.repeat(32);
const NODE_STUCK = 'd'.repeat(32);
const NODE_BOOM = 'f'.repeat(32);
const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(''),
  };
}

async function testContext(
  gateway: FakeGateway,
  options: { node?: string; json?: boolean; fetchImpl?: FetchLike } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-login-'));
  dirs.push(dir);
  const stdout = collector();
  const stderr = collector();
  const ctx = buildContext({
    entryFlag: ENTRY,
    node: options.node ?? null,
    json: options.json ?? false,
    quiet: false,
    noColor: true,
    configDir: dir,
    installEntry: null,
    env: {},
    fetchImpl: options.fetchImpl ?? gateway.fetch,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { ctx, stdout, stderr, dir };
}

describe('vibeterm login', () => {
  test('logs into the entry and every mesh node with one password', async () => {
    const user = await createFakeUser({ password: 'correct horse' });
    const gateway = createFakeGateway({ user, nodes: { [NODE_A]: 'office' } });
    const { ctx, stdout } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'correct horse';

    const code = await login.run(ctx, []);

    expect(code).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(true);
    const payload = JSON.parse(stdout.text()) as { nodes: Array<{ node: string; ok: boolean }> };
    expect(payload.nodes.map((row) => row.node)).toEqual(['self', NODE_A]);
    expect(payload.nodes.every((row) => row.ok)).toBe(true);
  });

  test('persists the session cookie and the identity', async () => {
    const user = await createFakeUser({ password: 'pw', username: 'root' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    await login.run(ctx, []);

    const stored = ctx.sessions.entry(ENTRY);
    expect(stored?.uid).toBe(user.uid);
    expect(stored?.username).toBe('root');
    expect(stored?.nodes.self.sid).toBe(gateway.issued.get('self'));
  });

  test('sends Origin = entry origin on every request', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user, nodes: { [NODE_A]: 'office' } });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    await login.run(ctx, []);

    expect(gateway.requests.length).toBeGreaterThan(3);
    expect(gateway.requests.every((row) => row.origin === ENTRY)).toBe(true);
    const authPosts = gateway.requests.filter(
      (row) => row.path.endsWith('/api/auth/challenge') || row.path.endsWith('/api/auth/login')
    );
    expect(authPosts.length).toBeGreaterThan(0);
    expect(authPosts.every((row) => row.client === 'cli')).toBe(true);
    const other = gateway.requests.filter((row) => !authPosts.includes(row));
    expect(other.every((row) => row.client === null)).toBe(true);
  });

  test('reaches other nodes through /n/<id> with that node’s own cookie', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user, nodes: { [NODE_A]: 'office' } });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    await login.run(ctx, []);
    await ctx.http.json(NODE_A, 'GET', '/api/system/info');

    const nodeCall = gateway.requests.at(-1);
    expect(nodeCall?.path).toBe(`/n/${NODE_A}/api/system/info`);
    expect(nodeCall?.cookie).toContain(`vibeterm_s_${NODE_A}=`);
    expect(nodeCall?.cookie).toContain('vibeterm_s_self=');
  });

  test('a wrong password fails with exit code 3', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'wrong';

    const error = (await login.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe('INVALID_CREDENTIALS');
  });

  test('TOTP: the derived k_totp and the code are accepted', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, ['--totp', gateway.currentTotp() as string]);

    expect(code).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
  });

  test('TOTP required but not supplied fails with exit 3 naming --totp', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.hint).toContain('--totp');
    expect(error.hint).toContain('VIBETERM_TOTP');
  });

  test('a wrong TOTP code is reported as TOTP_INVALID', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login.run(ctx, ['--totp', '000000']).catch((err) => err)) as AuthError;
    expect(error.code).toBe('TOTP_INVALID');
  });

  test('PASSKEY_REQUIRED explains that a TOTP code satisfies "either"', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({
      user,
      forceLoginError: 'PASSKEY_REQUIRED',
      secondFactorPolicy: 'either',
    });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login
      .run(ctx, ['--totp', gateway.currentTotp() as string])
      .catch((err) => err)) as AuthError;
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe('PASSKEY_REQUIRED');
    expect(error.hint).toContain('--totp');
  });

  test('--node logs into the entry plus that node only', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', ['b'.repeat(32)]: 'home' },
    });
    const { ctx, stdout } = await testContext(gateway, { node: 'office', json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    await login.run(ctx, []);

    const payload = JSON.parse(stdout.text()) as { nodes: Array<{ node: string }> };
    expect(payload.nodes.map((row) => row.node)).toEqual(['self', NODE_A]);
    expect(gateway.issued.has('b'.repeat(32))).toBe(false);
  });

  test('--node and --all-nodes conflict', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway, { node: 'office' });
    const error = await login.run(ctx, ['--all-nodes']).catch((err) => err);
    expect((error as Error).message).toContain('mutually exclusive');
  });

  test('an open standalone entry needs no login', async () => {
    const gateway = createFakeGateway({ user: await createFakeUser({ password: 'pw' }) });
    const openGateway: FakeGateway = {
      ...gateway,
      fetch: async (url, init) =>
        url.endsWith('/api/auth/mode')
          ? new Response('{"error":"Not found"}', { status: 404 })
          : gateway.fetch(url, init),
    };
    const { ctx, stdout } = await testContext(openGateway, { json: true });
    const code = await login.run(ctx, []);
    expect(code).toBeUndefined();
    expect(JSON.parse(stdout.text()).login).toBe('not-required');
  });
});

describe('vibeterm whoami / logout', () => {
  test('whoami reports the entry, user and per-node session state', async () => {
    const user = await createFakeUser({ password: 'pw', username: 'root' });
    const gateway = createFakeGateway({ user, nodes: { [NODE_A]: 'office' } });
    const { ctx, stdout } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);

    await whoami.run(ctx, []);

    const lines = stdout.text().trim().split('\n');
    const payload = JSON.parse(lines[lines.length - 1]) as {
      user: { username: string };
      nodes: Array<{ node: string; loggedIn: boolean }>;
    };
    expect(payload.user.username).toBe('root');
    expect(payload.nodes.find((row) => row.node === 'self')?.loggedIn).toBe(true);
    expect(payload.nodes.find((row) => row.node === NODE_A)?.loggedIn).toBe(true);
    expect(payload.nodes.find((row) => row.node === 'self')).toMatchObject({ ready: true });
  });

  test('whoami without a session exits 3', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx, stdout } = await testContext(gateway, { json: true });
    const code = await whoami.run(ctx, []);
    expect(code).toBe(3);
    expect(JSON.parse(stdout.text())).toEqual({
      loggedIn: false,
      entry: ENTRY,
      hint: 'vibeterm login',
    });
  });

  test('logout revokes every node session and clears the local entry', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user, nodes: { [NODE_A]: 'office' } });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);

    await logout.run(ctx, []);

    expect(gateway.issued.size).toBe(0);
    expect(ctx.sessions.entry(ENTRY)).toBeNull();
  });
});

describe('login against an older entry (mode fields absent)', () => {
  test('sends k_totp with --totp even when totpEnabled is not advertised', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({ user, omitTotpFields: true });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, ['--totp', gateway.currentTotp() as string]);

    expect(code).toBe(0);
    const totp = gateway.loginBodies[0].body.totp as { code: string; k_totp: string };
    expect(totp.k_totp).toBe(user.expectedKTotp);
    expect(gateway.issued.has('self')).toBe(true);
  });

  test('a non-TOTP account still logs in with no totp field', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user, omitTotpFields: true });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    expect(gateway.loginBodies[0].body.totp).toBeUndefined();
  });

  test('TOTP_REQUIRED from an old entry is reported with the --totp hint', async () => {
    const user = await createFakeUser({ password: 'pw', totp: true });
    const gateway = createFakeGateway({ user, omitTotpFields: true });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe('TOTP_REQUIRED');
    expect(error.hint).toContain('--totp');
  });
});

describe('entry public key verification', () => {
  test('a roster key that does not match the challenge aborts and drops the session', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const impostor = encodeBase64url(generateEd25519KeyPair().publicKey);
    const gateway = createFakeGateway({ user, selfPublicKeyOverride: impostor });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login.run(ctx, []).catch((err) => err)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.code).toBe('NODE_PK_MISMATCH');
    expect(error.message).toContain('does not match the mesh roster');
    expect(ctx.sessions.entry(ENTRY)).toBeNull();
  });

  test('a matching roster key logs in normally', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    expect(ctx.sessions.entry(ENTRY)?.nodes.self.sid).toBe(gateway.issued.get('self') as string);
  });
});

describe('fan-out failures', () => {
  test('PASSKEY_REQUIRED on a remote node exits 3, explains itself and never re-POSTs', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      secondFactorPolicy: 'either',
      forceLoginErrorFor: { [NODE_A]: 'PASSKEY_REQUIRED' },
    });
    const { ctx, stderr } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, []);

    expect(code).toBe(3);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.loginBodies.filter((entry) => entry.nodeId === NODE_A)).toHaveLength(1);
    expect(stderr.text()).toContain('passkey assertion');
    expect(stderr.text()).toContain('--totp');
  });

  test('NODE_UNREACHABLE on one node skips it, logs into the rest, exits 0', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_OFFLINE]: 'oracle' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_OFFLINE}/`)) {
        return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: NODE_OFFLINE }), {
          status: 503,
        });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, []);

    expect(code).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(true);
    expect(gateway.issued.has(NODE_OFFLINE)).toBe(false);
    expect(stderr.text()).toContain('skipped oracle: unreachable');
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === NODE_A)?.ok).toBe(true);
    expect(payload.nodes.find((row) => row.node === NODE_OFFLINE)).toMatchObject({
      ok: false,
      code: 'NODE_UNREACHABLE',
    });
  });

  test('unreachable skip prints a summary and still exits 0', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_OFFLINE]: 'oracle' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_OFFLINE}/`)) {
        return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: NODE_OFFLINE }), {
          status: 503,
        });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, { fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    expect(stderr.text()).toContain('skipped oracle: unreachable');
    expect(stderr.text()).toContain('logged in to 2 nodes, skipped 1 unreachable');
  });

  test('a network error on one node is skipped as unreachable', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_OFFLINE]: 'oracle' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_OFFLINE}/`)) throw new Error('ECONNREFUSED');
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    expect(gateway.issued.has(NODE_A)).toBe(true);
    expect(stderr.text()).toContain('skipped oracle: unreachable');
  });

  test('entry challenge NetworkError exits 5 with the original message', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes('/api/auth/challenge')) throw new Error('ECONNRESET');
      return gateway.fetch(url, init);
    };
    const { ctx } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login.run(ctx, []).catch((err) => err)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
    expect(error.message).toContain('ECONNRESET');
    expect(error.message).toContain('/api/auth/challenge');
  });

  test('--node targeting an unreachable node exits 5', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_OFFLINE]: 'oracle' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_OFFLINE}/`)) {
        return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: NODE_OFFLINE }), {
          status: 503,
        });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, {
      node: 'oracle',
      json: true,
      fetchImpl,
    });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(5);
    expect(gateway.issued.has('self')).toBe(true);
    expect(stderr.text()).not.toContain('logged in to 1 nodes');
    expect(stderr.text()).toContain('skipped oracle: unreachable');
    expect(stderr.text()).not.toContain(`node ${NODE_OFFLINE} (oracle): unreachable`);
  });

  test('one successful node uses the singular noun', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_OFFLINE]: 'oracle' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_OFFLINE}/`)) {
        return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: NODE_OFFLINE }), {
          status: 503,
        });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, { fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    expect(stderr.text()).toContain('logged in to 1 node, skipped 1 unreachable');
    expect(stderr.text()).not.toContain('1 nodes');
  });

  test('a reachable node that rejects login exits non-zero', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      forceLoginErrorFor: { [NODE_A]: 'INVALID_CREDENTIALS' },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(3);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(false);
  });

  test('every failed node gets its own explanation, the entry still keeps its session', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const other = 'b'.repeat(32);
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [other]: 'home' },
      forceLoginErrorFor: { [NODE_A]: 'PASSKEY_REQUIRED', [other]: 'RATE_LIMITED' },
    });
    const { ctx, stderr } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(3);
    expect(stderr.text()).toContain(`node ${NODE_A}`);
    expect(stderr.text()).toContain(`node ${other}`);
    expect(stderr.text()).toContain('rate limiting');
    expect(ctx.sessions.entry(ENTRY)?.nodes.self.sid).toBeTruthy();
  });
});

function nodeIdFromUrl(url: string): string | null {
  const match = /\/n\/([0-9a-f]{32})\//.exec(url);
  return match?.[1] ?? null;
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

function hangUntilAbort(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(abortError());
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

function sleepOrAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const fail = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

describe('login progress, timeout and concurrency', () => {
  test('prints per-node start and result on stderr while a node is still hanging', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home', [NODE_STUCK]: 'stuck' },
    });
    let abortedStuck = false;
    const fetchImpl: FetchLike = async (url, init) => {
      if (nodeIdFromUrl(String(url)) === NODE_STUCK) {
        try {
          await hangUntilAbort(init?.signal);
        } catch (error) {
          abortedStuck = true;
          throw error;
        }
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, ['--node-timeout', '200']);
    const err = stderr.text();
    const out = stdout.text();

    expect(code).toBe(0);
    expect(abortedStuck).toBe(true);
    expect(err).toContain('logging in to self (entry) ...');
    expect(err).toContain('logged in to self (entry): ok');
    expect(err).toContain('logging in to office ...');
    expect(err).toContain('logged in to office: ok');
    expect(err).toContain('logging in to home ...');
    expect(err).toContain('logged in to home: ok');
    expect(err).toContain('logging in to stuck ...');
    expect(err).toContain('skipped stuck: timeout');
    expect(err).toContain('logged in to 3 nodes, skipped 1 timeout');
    expect(out).toContain('TIMEOUT');
    expect(out.indexOf('office')).toBeLessThan(out.indexOf('home'));
    expect(out.indexOf('home')).toBeLessThan(out.indexOf('stuck'));
  });

  test('--json stdout is a single object; progress stays on stderr', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
    });
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(0);
    const lines = stdout.text().trim().split('\n');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]) as {
      entry: string;
      nodes: Array<{ node: string; ok: boolean }>;
    };
    expect(payload.entry).toBe(ENTRY);
    expect(payload.nodes.map((row) => row.node)).toEqual(['self', NODE_A, NODE_HOME]);
    expect(stderr.text()).toContain('logging in to office ...');
    expect(stderr.text()).not.toMatch(/^\s*\{/m);
  });

  test('concurrent logins keep roster order even when a later node finishes first', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home', [NODE_STUCK]: 'lab' },
    });
    const delayMs: Record<string, number> = {
      [NODE_A]: 80,
      [NODE_HOME]: 40,
      [NODE_STUCK]: 10,
    };
    const started: number[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const nodeId = nodeIdFromUrl(String(url));
      const delay = nodeId ? delayMs[nodeId] : undefined;
      if (delay !== undefined && String(url).includes('/api/auth/challenge')) {
        started.push(Date.now());
        await sleepOrAbort(delay, init?.signal);
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stdout } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, ['--concurrency', '4'])).toBe(0);
    const payload = JSON.parse(stdout.text()) as { nodes: Array<{ node: string; ok: boolean }> };
    expect(payload.nodes.map((row) => row.node)).toEqual(['self', NODE_A, NODE_HOME, NODE_STUCK]);
    expect(payload.nodes.every((row) => row.ok)).toBe(true);
    expect(started).toHaveLength(3);
    expect(Math.max(...started) - Math.min(...started)).toBeLessThan(50);
  });

  test('TIMEOUT is skipped as network-class and exits 0 without --node', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_STUCK]: 'stuck' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (nodeIdFromUrl(String(url)) === NODE_STUCK) return hangUntilAbort(init?.signal);
      return gateway.fetch(url, init);
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, ['--node-timeout', '150'])).toBe(0);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === NODE_A)?.ok).toBe(true);
    expect(payload.nodes.find((row) => row.node === NODE_STUCK)).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
    });
    expect(stderr.text()).toContain('skipped stuck: timeout');
  });

  test('--node targeting a timed-out node exits 5', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_STUCK]: 'stuck' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (nodeIdFromUrl(String(url)) === NODE_STUCK) return hangUntilAbort(init?.signal);
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, {
      node: 'stuck',
      json: true,
      fetchImpl,
    });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, ['--node-timeout', '150'])).toBe(5);
    expect(gateway.issued.has('self')).toBe(true);
    expect(stderr.text()).toContain('skipped stuck: timeout');
    expect(stderr.text()).not.toContain(`node ${NODE_STUCK} (stuck): timeout`);
    expect(stderr.text()).not.toContain('logged in to 1 node, skipped');
  });

  test('TIMEOUT mixed with an auth rejection still exits 3', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_STUCK]: 'stuck' },
      forceLoginErrorFor: { [NODE_A]: 'INVALID_CREDENTIALS' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (nodeIdFromUrl(String(url)) === NODE_STUCK) return hangUntilAbort(init?.signal);
      return gateway.fetch(url, init);
    };
    const { ctx, stderr } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, ['--node-timeout', '150'])).toBe(3);
    expect(stderr.text()).toContain('invalid username or password');
    expect(stderr.text()).toContain('skipped stuck: timeout');
  });

  test('--node-timeout and --concurrency reject non-positive values', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    process.env.VIBETERM_PASSWORD = 'pw';
    const timeoutErr = await login.run(ctx, ['--node-timeout', '0']).catch((err) => err);
    expect(timeoutErr).toBeInstanceOf(UsageError);
    expect((timeoutErr as Error).message).toContain('--node-timeout');
    const concErr = await login.run(ctx, ['--concurrency', '0']).catch((err) => err);
    expect(concErr).toBeInstanceOf(UsageError);
    expect((concErr as Error).message).toContain('--concurrency');
  });

  test('concurrent TOTP_REQUIRED does not prompt and still exits 3', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      forceLoginErrorFor: { [NODE_A]: 'TOTP_REQUIRED', [NODE_HOME]: 'TOTP_REQUIRED' },
    });
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(3);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === NODE_A)?.code).toBe('TOTP_REQUIRED');
    expect(payload.nodes.find((row) => row.node === NODE_HOME)?.code).toBe('TOTP_REQUIRED');
    expect(stderr.text()).toContain('logging in to office ...');
    expect(stderr.text()).toContain('logging in to home ...');
    expect(stderr.text()).toContain('two-step verification');
  });

  test('usage says login ignores global --timeout', () => {
    expect(login.usage).toContain('ignore the global `--timeout`');
    expect(login.usage).toContain('--node-timeout');
  });

  test('entry timeout names --node-timeout in the hint', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes('/api/auth/challenge') && !String(url).includes('/n/')) {
        return hangUntilAbort(init?.signal);
      }
      return gateway.fetch(url, init);
    };
    const { ctx } = await testContext(gateway, { fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    const error = (await login
      .run(ctx, ['--node-timeout', '80'])
      .catch((err) => err)) as NetworkError;
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.exitCode).toBe(5);
    expect(error.hint).toContain('--node-timeout');
  });

  test('a 500 on the second node does not zeroize keys or abort the table', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_BOOM]: 'boom', [NODE_HOME]: 'home' },
    });
    let inFlight = 0;
    let boomFailed = false;
    let homeChallengeAfterBoom = false;
    const fetchImpl: FetchLike = async (url, init) => {
      inFlight += 1;
      try {
        const nodeId = nodeIdFromUrl(String(url));
        if (nodeId === NODE_BOOM && String(url).includes('/api/auth/challenge')) {
          boomFailed = true;
          return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
        }
        // 拖住 home 的 challenge，让 boom 的抛错窗口盖过 signLogin 之前。
        if (nodeId === NODE_HOME && String(url).includes('/api/auth/challenge')) {
          await sleepOrAbort(80, init?.signal);
          homeChallengeAfterBoom = boomFailed;
        }
        return gateway.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    const code = await login.run(ctx, ['--concurrency', '2']);
    const out = stdout.text();
    const homeLogin = gateway.loginBodies.find((entry) => entry.nodeId === NODE_HOME);
    const sig = decodeBase64url(String(homeLogin?.body.sig ?? ''));

    expect(code).toBe(1);
    expect(inFlight).toBe(0);
    expect(homeChallengeAfterBoom).toBe(true);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(true);
    expect(gateway.issued.has(NODE_HOME)).toBe(true);
    expect(gateway.issued.has(NODE_BOOM)).toBe(false);
    expect(sig.some((byte) => byte !== 0)).toBe(true);
    expect(out).toContain('NODE');
    expect(out).toContain('STATUS');
    expect(out).toContain('HTTP_500');
    expect(out).toContain(NODE_A);
    expect(out).toContain(NODE_HOME);
    expect(out).toContain(NODE_BOOM);
    expect(stderr.text()).toContain('login to boom failed: HTTP_500');
    expect(stderr.text()).toContain('logged in to home: ok');
  });

  test('HTTP_500 mixed with an auth rejection exits 1 and still prints the table', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_BOOM]: 'boom' },
      forceLoginErrorFor: { [NODE_A]: 'INVALID_CREDENTIALS' },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (nodeIdFromUrl(String(url)) === NODE_BOOM && String(url).includes('/api/auth/challenge')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true, fetchImpl });
    process.env.VIBETERM_PASSWORD = 'pw';

    expect(await login.run(ctx, [])).toBe(1);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === NODE_A)).toMatchObject({
      ok: false,
      code: 'INVALID_CREDENTIALS',
    });
    expect(payload.nodes.find((row) => row.node === NODE_BOOM)).toMatchObject({
      ok: false,
      code: 'HTTP_500',
    });
    expect(stderr.text()).toContain('invalid username or password');
    expect(stderr.text()).toContain('HTTP_500');
  });
});
