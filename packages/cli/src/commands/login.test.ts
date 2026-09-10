import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { encodeBase64url, generateEd25519KeyPair } from '@vibeterm/shared/auth';
import { buildContext } from '../core/context';
import { AuthError } from '../core/errors';
import { type FakeGateway, createFakeGateway, createFakeUser } from '../core/test-fakes';
import { command as login } from './login';
import { command as logout } from './logout';
import { command as whoami } from './whoami';

const ENTRY = 'http://entry.example:9883';
const NODE_A = 'a'.repeat(32);
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

async function testContext(gateway: FakeGateway, options: { node?: string; json?: boolean } = {}) {
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
    fetchImpl: gateway.fetch,
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
  });

  test('whoami without a session exits 3', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway, { json: true });
    const error = (await whoami.run(ctx, []).catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
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
