import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { LOGIN_CODE_REDEEM_PATH } from '@vibeterm/shared';
import {
  decodeBase64url,
  deriveNodeLoginCode,
  encodeBase64url,
  encodeLoginCode,
  generateLoginCodeSecret,
} from '@vibeterm/shared/auth';
import { buildContext } from '../core/context';
import { AuthError, UsageError } from '../core/errors';
import { type FetchLike, isAuthFlowPath } from '../core/http';
import { type FakeGateway, createFakeGateway, createFakeUser } from '../core/test-fakes';
import { command as login } from './login';

const ENTRY = 'http://entry.example:9883';
const ENTRY_NODE = 'e'.repeat(32);
const NODE_A = 'a'.repeat(32);
const NODE_HOME = 'b'.repeat(32);
const dirs: string[] = [];

function expectLivePop(sessSk?: string, sessPk?: string): void {
  const sk = decodeBase64url(sessSk ?? '');
  const pk = decodeBase64url(sessPk ?? '');
  expect(sk.some((byte) => byte !== 0)).toBe(true);
  expect(pk.some((byte) => byte !== 0)).toBe(true);
  expect(pk.byteLength).toBe(32);
}

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  delete process.env.VIBETERM_TOTP;
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
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-login-code-'));
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

function makeCode(secret: Uint8Array, nodeIds: string[]): string {
  return encodeLoginCode({ secret, nodeIds });
}

async function withStdin<T>(text: string, run: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const stream = Readable.from([text]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'stdin', { configurable: true, value: original });
  }
}

describe('vibeterm login --code', () => {
  test('redeems self then a remote and stores sid + sessSk per node', async () => {
    const user = await createFakeUser({ password: 'pw', username: 'alice' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      loginCode: { secret },
    });
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'wrong-password';
    process.env.VIBETERM_TOTP = '000000';
    const code = makeCode(secret, [NODE_A, ENTRY_NODE]);

    const exit = await login.run(ctx, ['--code', code]);

    expect(exit).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(true);
    expect(gateway.redeemBodies.map((row) => row.nodeId)).toEqual(['self', NODE_A]);
    expect(gateway.redeemBodies.every((row) => row.body.pop === true)).toBe(true);
    expect(gateway.redeemBodies[0].body.code).toBe(
      encodeBase64url(deriveNodeLoginCode(secret, ENTRY_NODE))
    );
    expect(gateway.redeemBodies[1].body.code).toBe(
      encodeBase64url(deriveNodeLoginCode(secret, NODE_A))
    );

    const stored = ctx.sessions.entry(ENTRY);
    expect(stored?.uid).toBe(user.uid);
    expect(stored?.username).toBe('alice');
    expect(stored?.nodes.self.sid).toBe(gateway.issued.get('self'));
    expect(stored?.nodes[NODE_A].sid).toBe(gateway.issued.get(NODE_A));
    expect(stored?.nodes.self.sessSk).toBeTruthy();
    expect(stored?.nodes.self.sessPk).toBeTruthy();
    expect(stored?.nodes[NODE_A].sessSk).toBe(stored?.nodes.self.sessSk);
    expect(stored?.nodes[NODE_A].sessPk).toBe(stored?.nodes.self.sessPk);
    expect([32, 64]).toContain(decodeBase64url(stored?.nodes.self.sessSk ?? '').byteLength);
    expect(decodeBase64url(stored?.nodes.self.sessPk ?? '').byteLength).toBe(32);
    expect(gateway.redeemBodies[0].body.sess_pk).toBe(stored?.nodes.self.sessPk);

    const payload = JSON.parse(stdout.text()) as {
      entry: string;
      nodes: Array<{ node: string; name: string; ok: boolean }>;
    };
    expect(payload.entry).toBe(ENTRY);
    expect(payload.nodes.map((row) => row.node)).toEqual(['self', NODE_A]);
    expect(payload.nodes.map((row) => row.name)).toEqual(['entry', 'office']);
    expect(payload.nodes.every((row) => row.ok)).toBe(true);

    const redeems = gateway.requests.filter((row) => row.path.endsWith(LOGIN_CODE_REDEEM_PATH));
    expect(redeems.map((row) => row.path)).toEqual([
      LOGIN_CODE_REDEEM_PATH,
      `/n/${NODE_A}${LOGIN_CODE_REDEEM_PATH}`,
    ]);
    expect(redeems.every((row) => row.client === 'cli')).toBe(true);
    expect(redeems.every((row) => !row.cookie || !/vibeterm_[st]_/.test(row.cookie))).toBe(true);
    expect(stderr.text()).toContain('logging in to self ...');
    expect(stderr.text()).toContain('logged in to office: ok');
  });

  test('a partial login code reuses the stored self pair', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);
    const storedPk = ctx.sessions.entry(ENTRY)?.nodes.self.sessPk;
    const storedSk = ctx.sessions.entry(ENTRY)?.nodes.self.sessSk;
    expect(storedPk).toBeTruthy();

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);
    expect(exit).toBe(0);
    const after = ctx.sessions.entry(ENTRY);
    expect(after?.nodes.self.sessPk).toBe(storedPk);
    expect(after?.nodes[NODE_A].sessPk).toBe(storedPk);
    expect(after?.nodes[NODE_HOME].sessPk).toBe(storedPk);
    expectLivePop(after?.nodes.self.sessSk, after?.nodes.self.sessPk);
    expect(gateway.redeemBodies.every((row) => row.body.sess_pk === storedPk)).toBe(true);
    expect(after?.nodes.self.sessSk).toBe(storedSk);
  });

  test('an all-nodes login code generates a fresh pair', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);
    const storedPk = ctx.sessions.entry(ENTRY)?.nodes.self.sessPk;
    expect(storedPk).toBeTruthy();

    const exit = await login.run(ctx, [
      '--code',
      makeCode(secret, [ENTRY_NODE, NODE_A, NODE_HOME]),
    ]);
    expect(exit).toBe(0);
    const after = ctx.sessions.entry(ENTRY);
    expect(after?.nodes.self.sessPk).toBeTruthy();
    expect(after?.nodes.self.sessPk).not.toBe(storedPk);
    expect(after?.nodes[NODE_A].sessPk).toBe(after?.nodes.self.sessPk);
    expect(after?.nodes[NODE_HOME].sessPk).toBe(after?.nodes.self.sessPk);
    expectLivePop(after?.nodes.self.sessSk, after?.nodes.self.sessPk);
  });

  test('a login code with no stored pair generates a fresh pair', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    expect(ctx.sessions.entry(ENTRY)).toBeNull();

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);
    expect(exit).toBe(0);
    const stored = ctx.sessions.entry(ENTRY);
    expect(stored?.nodes.self.sessPk).toBeTruthy();
    expect(stored?.nodes[NODE_A].sessPk).toBe(stored?.nodes.self.sessPk);
    expect(gateway.redeemBodies[0].body.sess_pk).toBe(stored?.nodes.self.sessPk);
    expectLivePop(stored?.nodes.self.sessSk, stored?.nodes.self.sessPk);
  });

  test('a partial login code generates a fresh pair when the self session is expired', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);
    const storedPk = ctx.sessions.entry(ENTRY)?.nodes.self.sessPk;
    expect(storedPk).toBeTruthy();
    const self = ctx.sessions.entry(ENTRY)?.nodes.self;
    ctx.sessions.setNodeSession(ENTRY, {
      nodeId: 'self',
      sid: self?.sid ?? '',
      expiresAt: 1,
    });
    ctx.sessions.save();

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);
    expect(exit).toBe(0);
    const after = ctx.sessions.entry(ENTRY);
    expect(after?.nodes.self.sessPk).toBeTruthy();
    expect(after?.nodes.self.sessPk).not.toBe(storedPk);
    expect(after?.nodes[NODE_A].sessPk).toBe(after?.nodes.self.sessPk);
    expect(after?.nodes[NODE_HOME].sessPk).toBe(storedPk);
    expectLivePop(after?.nodes.self.sessSk, after?.nodes.self.sessPk);
  });

  test('a partial login code generates a fresh pair when the self session is missing', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);
    const storedPk = ctx.sessions.entry(ENTRY)?.nodes.self.sessPk;
    expect(storedPk).toBeTruthy();
    ctx.sessions.clearNodeSession(ENTRY, 'self');
    ctx.sessions.save();

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);
    expect(exit).toBe(0);
    const after = ctx.sessions.entry(ENTRY);
    expect(after?.nodes.self.sessPk).toBeTruthy();
    expect(after?.nodes.self.sessPk).not.toBe(storedPk);
    expect(after?.nodes[NODE_A].sessPk).toBe(after?.nodes.self.sessPk);
    expect(after?.nodes[NODE_HOME].sessPk).toBe(storedPk);
    expectLivePop(after?.nodes.self.sessSk, after?.nodes.self.sessPk);
  });

  test('a partial login code generates a fresh pair when the stored uid differs', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office', [NODE_HOME]: 'home' },
      loginCode: { secret },
    });
    const { ctx } = await testContext(gateway, { json: true });
    process.env.VIBETERM_PASSWORD = 'pw';
    await login.run(ctx, []);
    const storedPk = ctx.sessions.entry(ENTRY)?.nodes.self.sessPk;
    expect(storedPk).toBeTruthy();
    ctx.sessions.setIdentity(ENTRY, { uid: 'other-uid', username: 'other' });
    ctx.sessions.save();

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);
    expect(exit).toBe(0);
    const after = ctx.sessions.entry(ENTRY);
    expect(after?.nodes.self.sessPk).toBeTruthy();
    expect(after?.nodes.self.sessPk).not.toBe(storedPk);
    expect(after?.nodes[NODE_A].sessPk).toBe(after?.nodes.self.sessPk);
    expect(after?.nodes[NODE_HOME].sessPk).toBe(storedPk);
    expect(after?.uid).toBe(user.uid);
    expectLivePop(after?.nodes.self.sessSk, after?.nodes.self.sessPk);
  });

  test('--code conflicts with password/totp/user/all-nodes/--node', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    const code = 'vtl1_placeholder';

    const password = await login.run(ctx, ['--code', code, '--password-stdin']).catch((err) => err);
    expect(password).toBeInstanceOf(UsageError);
    expect((password as Error).message).toContain('--password-stdin');

    const totp = await login.run(ctx, ['--code', code, '--totp', '111111']).catch((err) => err);
    expect((totp as Error).message).toContain('--totp');

    const userFlag = await login.run(ctx, ['--code', code, '--user', 'alice']).catch((err) => err);
    expect((userFlag as Error).message).toContain('--user');

    const allNodes = await login.run(ctx, ['--code', code, '--all-nodes']).catch((err) => err);
    expect((allNodes as Error).message).toContain('--all-nodes');

    const { ctx: withNode } = await testContext(gateway, { node: 'office' });
    const node = await login.run(withNode, ['--code', code]).catch((err) => err);
    expect((node as Error).message).toContain('--node');
    expect((node as Error).message).toContain('mutually exclusive');
  });

  test('an invalid login code is a usage error', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const gateway = createFakeGateway({ user });
    const { ctx } = await testContext(gateway);
    const error = (await login
      .run(ctx, ['--code', 'not-a-code'])
      .catch((err) => err)) as UsageError;
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe('invalid login code');
    expect(error.hint).toContain('copy the whole command from the web UI again');
  });

  test('LOGIN_CODE_USED on a remote maps to exit 3 with a hint', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      loginCode: { secret },
      forceRedeemErrorFor: { [NODE_A]: 'LOGIN_CODE_USED' },
    });
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true });

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);

    expect(exit).toBe(3);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(false);
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === NODE_A)).toMatchObject({
      ok: false,
      code: 'LOGIN_CODE_USED',
    });
    expect(stderr.text()).toContain('already used');
    expect(stderr.text()).toContain('generate a new one in the web UI');
  });

  test('LOGIN_CODE_EXPIRED maps to exit 3 with the expired hint', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      loginCode: { secret },
      forceRedeemErrorFor: { self: 'LOGIN_CODE_EXPIRED' },
    });
    const { ctx, stderr } = await testContext(gateway, { json: true });

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE])]);

    expect(exit).toBe(3);
    expect(stderr.text()).toContain('the login command expired');
    expect(stderr.text()).toContain('generate a new one in the web UI');
  });

  test('a partial network failure is skipped and exits 0', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({
      user,
      nodes: { [NODE_A]: 'office' },
      loginCode: { secret },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes(`/n/${NODE_A}/`)) {
        return new Response(JSON.stringify({ code: 'NODE_UNREACHABLE', nodeId: NODE_A }), {
          status: 503,
        });
      }
      return gateway.fetch(url, init);
    };
    const { ctx, stdout, stderr } = await testContext(gateway, { json: true, fetchImpl });

    const exit = await login.run(ctx, ['--code', makeCode(secret, [ENTRY_NODE, NODE_A])]);

    expect(exit).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.issued.has(NODE_A)).toBe(false);
    expect(stderr.text()).toContain('skipped office: unreachable');
    const payload = JSON.parse(stdout.text()) as {
      nodes: Array<{ node: string; ok: boolean; code?: string }>;
    };
    expect(payload.nodes.find((row) => row.node === 'self')?.ok).toBe(true);
    expect(payload.nodes.find((row) => row.node === NODE_A)).toMatchObject({
      ok: false,
      code: 'NODE_UNREACHABLE',
    });
  });

  test('reads the code from stdin when --code is -', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({ user, loginCode: { secret } });
    const { ctx } = await testContext(gateway, { json: true });
    const printed = `  ${makeCode(secret, [ENTRY_NODE])}\n`;

    const exit = await withStdin(printed, () => login.run(ctx, ['--code', '-']));

    expect(exit).toBe(0);
    expect(gateway.issued.has('self')).toBe(true);
    expect(gateway.redeemBodies).toHaveLength(1);
  });

  test('an open standalone entry rejects a login code', async () => {
    const user = await createFakeUser({ password: 'pw' });
    const secret = generateLoginCodeSecret();
    const gateway = createFakeGateway({ user, loginCode: { secret } });
    const openGateway: FakeGateway = {
      ...gateway,
      fetch: async (url, init) =>
        url.toString().includes('/api/auth/mode')
          ? new Response('{"error":"Not found"}', { status: 404 })
          : gateway.fetch(url, init),
    };
    const { ctx } = await testContext(openGateway);
    const error = (await login
      .run(ctx, ['--code', makeCode(secret, [ENTRY_NODE])])
      .catch((err) => err)) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.exitCode).toBe(3);
    expect(error.message).toContain(ENTRY);
    expect(error.message).toContain('does not use accounts');
  });

  test('usage mentions --code', () => {
    expect(login.usage).toContain('--code <code|->');
    expect(login.usage).toContain('Settings → Nodes → Login command');
    expect(isAuthFlowPath('/api/auth/login-code/redeem')).toBe(true);
  });
});
