import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeRotateRootKeepPayload,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import type { FetchLike } from '../core/http';
import { type FakeGateway, type FakeUser, createFakeGateway } from '../core/test-fakes';
import { NODE, testContext } from './cli-test-harness';
import { passwd, passwdCascadeNotice, passwdReloginBackoff } from './settings-security';

const dirs: string[] = [];
const backoff = { ...passwdReloginBackoff };

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  delete process.env.VIBETERM_NEW_PASSWORD;
  delete process.env.VIBETERM_CLI_LANG;
  delete process.env.LANG;
  Object.assign(passwdReloginBackoff, backoff);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function realKdfUser(password: string): Promise<FakeUser> {
  const kdfParams = generateKdfParams();
  const seed = await deriveSeed(password, kdfParams);
  try {
    return {
      uid: 'u-1',
      username: 'admin',
      password,
      rootEpoch: 0,
      kdfParams,
      rootPublicKey: rootKeyFromSeed(seed).publicKey,
      totpSecret: null,
      expectedKTotp: encodeBase64url(deriveTotpKey(seed, 'u-1', 0)),
    };
  } finally {
    seed.fill(0);
  }
}

/** 入口在 key log 追加 rotate-root-keep 后换成新根钥：旧会话全部作废，只能用新口令重新登录。 */
function rotatingGateway(
  user: FakeUser,
  newPassword: string,
  extra: {
    nodes?: Record<string, string>;
    forceLoginErrorFor?: Record<string, string>;
  } = {}
) {
  const nextOpts = () => extra;
  let gateway: FakeGateway = createFakeGateway({ user, ...nextOpts() });
  const before = gateway;
  let appended = false;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.pathname === '/api/auth/keylog/head') {
      return Response.json({ seq: 3, hash: encodeBase64url(new Uint8Array(32).fill(1)) });
    }
    if (method === 'POST' && url.pathname === '/api/auth/keylog') {
      const body = JSON.parse(String(init?.body)) as { bytes: string };
      const record = decodeKeyLogRecord(decodeBase64url(body.bytes));
      const payload = decodeRotateRootKeepPayload(record.payload);
      gateway = createFakeGateway({
        user: {
          ...user,
          password: newPassword,
          rootEpoch: user.rootEpoch + 1,
          kdfParams: payload.kdf_params,
          rootPublicKey: payload.root_public_key,
        },
        ...nextOpts(),
      });
      appended = true;
      return Response.json({ ok: true, seq: 4, relayAck: true });
    }
    return gateway.fetch(input, init);
  };
  return {
    fetch: fetchImpl,
    before,
    after: () => gateway,
    appended: () => appended,
  };
}

describe('settings passwd', () => {
  test('keep 改密后用新口令重新登录入口，JSON 输出合并 relogin 结果', async () => {
    const user = await realKdfUser('old-pass-word');
    const gateway = rotatingGateway(user, 'new-pass-word');
    const built = await testContext(gateway.fetch, { json: true });
    dirs.push(built.dir);
    process.env.VIBETERM_PASSWORD = 'old-pass-word';
    process.env.VIBETERM_NEW_PASSWORD = 'new-pass-word';

    const code = await passwd(built.ctx, {}, []);

    expect(gateway.appended()).toBe(true);
    expect(code).toBe(0);
    const fresh = gateway.after();
    expect(fresh).not.toBe(gateway.before);
    expect(fresh.issued.has('self')).toBe(true);
    expect(built.ctx.sessions.entry(built.ctx.globals.entry)?.nodes.self.sid).toBe(
      fresh.issued.get('self')
    );
    const output = JSON.parse(built.stdout.text()) as {
      ok: boolean;
      relogin: Array<{ node: string; ok: boolean }>;
      cascadeNotice: string;
    };
    expect(output.ok).toBe(true);
    expect(output.relogin).toEqual([expect.objectContaining({ node: 'self', ok: true })]);
    expect(output.cascadeNotice).toBe(passwdCascadeNotice());
  });

  test('keep 改密后人读输出打印级联撤销说明', async () => {
    const user = await realKdfUser('old-pass-word');
    const gateway = rotatingGateway(user, 'new-pass-word');
    const built = await testContext(gateway.fetch);
    dirs.push(built.dir);
    process.env.VIBETERM_PASSWORD = 'old-pass-word';
    process.env.VIBETERM_NEW_PASSWORD = 'new-pass-word';
    process.env.VIBETERM_CLI_LANG = 'zh-CN';

    const code = await passwd(built.ctx, {}, []);

    expect(code).toBe(0);
    expect(built.stderr.text()).toContain('已撤销全部登录会话、访问令牌、终端分享与窗格授权');
  });

  test('名册节点暂时拒绝新委托时按间隔重试后成功', async () => {
    const user = await realKdfUser('old-pass-word');
    const forceLoginErrorFor: Record<string, string> = { [NODE]: 'INVALID_CREDENTIALS' };
    const gateway = rotatingGateway(user, 'new-pass-word', {
      nodes: { [NODE]: 'office' },
      forceLoginErrorFor,
    });
    const built = await testContext(gateway.fetch, { json: true });
    dirs.push(built.dir);
    process.env.VIBETERM_PASSWORD = 'old-pass-word';
    process.env.VIBETERM_NEW_PASSWORD = 'new-pass-word';
    const slept: number[] = [];
    passwdReloginBackoff.tries = 3;
    passwdReloginBackoff.gapMs = 3_000;
    passwdReloginBackoff.sleep = async (ms) => {
      slept.push(ms);
      delete forceLoginErrorFor[NODE];
    };

    const code = await passwd(built.ctx, {}, []);

    expect(code).toBe(0);
    expect(slept).toEqual([3_000]);
    const output = JSON.parse(built.stdout.text()) as {
      relogin: Array<{ node: string; ok: boolean }>;
    };
    expect(output.relogin).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ node: 'self', ok: true }),
        expect.objectContaining({ node: NODE, ok: true }),
      ])
    );
  });

  test('名册节点始终拒绝新委托时重试耗尽后告警', async () => {
    const user = await realKdfUser('old-pass-word');
    const gateway = rotatingGateway(user, 'new-pass-word', {
      nodes: { [NODE]: 'office' },
      forceLoginErrorFor: { [NODE]: 'INVALID_CREDENTIALS' },
    });
    const built = await testContext(gateway.fetch, { json: true });
    dirs.push(built.dir);
    process.env.VIBETERM_PASSWORD = 'old-pass-word';
    process.env.VIBETERM_NEW_PASSWORD = 'new-pass-word';
    const slept: number[] = [];
    passwdReloginBackoff.tries = 3;
    passwdReloginBackoff.gapMs = 3_000;
    passwdReloginBackoff.sleep = async (ms) => {
      slept.push(ms);
    };

    const code = await passwd(built.ctx, {}, []);

    expect(code).toBe(3);
    expect(slept).toEqual([3_000, 3_000]);
    expect(built.stderr.text()).toContain('rejected the new session');
  });
});
