import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import {
  deriveSeed,
  encodeBase32,
  encodeBase64url,
  generateKdfParams,
  rootKeyFromSeed,
  totpCode,
} from '@vibeterm/shared/auth';
import { NODE, routeFetch, testContext } from '../commands/cli-test-harness';
import {
  changeAccountPassword,
  confirmTotpCode,
  disableTotp,
  enableTotp,
  generateTotpSecret,
  removePasskey,
} from './account-security';
import { AuthError, UsageError } from './errors';

const dirs: string[] = [];

afterEach(async () => {
  delete process.env.VIBETERM_PASSWORD;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function meshFor(password: string) {
  const kdf = generateKdfParams();
  const seed = await deriveSeed(password, kdf);
  const root = rootKeyFromSeed(seed);
  seed.fill(0);
  const mode = {
    mode: 'mesh' as const,
    nodeId: NODE,
    uid: 'user-1',
    username: 'admin',
    kdfParams: {
      salt: encodeBase64url(kdf.salt),
      memory_kib: kdf.memory_kib,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
    },
    rootEpoch: 1,
    rootPublicKey: encodeBase64url(root.publicKey),
    totpEnabled: false,
    passkeysForThisOrigin: false,
    passkeyAvailable: false,
  };
  root.seed.fill(0);
  return {
    mode,
    head: { seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(2)), rootEpoch: 1 },
  };
}

async function signedCtx(password: string, extra: Parameters<typeof routeFetch>[0] = {}) {
  const { mode, head } = await meshFor(password);
  let keylog = '';
  const built = await testContext(
    routeFetch({
      'GET /api/auth/mode': () => mode,
      'GET /api/auth/keylog/head': () => head,
      'GET /api/auth/totp-record': () =>
        new Response(JSON.stringify({ code: 'TOTP_NOT_ENABLED' }), { status: 404 }),
      'POST /api/auth/keylog': (_url, init) => {
        keylog = String(init?.body);
        return { ok: true, seq: 5, relayAck: true };
      },
      ...extra,
    }),
    { json: true }
  );
  dirs.push(built.dir);
  return { ctx: built.ctx, keylog: () => keylog, mode };
}

describe('account-security keylog', () => {
  test('changeAccountPassword keep posts rotate-root-keep', async () => {
    const { ctx, keylog } = await signedCtx('old-pass-word');
    await changeAccountPassword(ctx, {
      fullReset: false,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
    });
    const body = JSON.parse(keylog()) as { bytes: string; sig: string };
    expect(typeof body.bytes).toBe('string');
    expect(typeof body.sig).toBe('string');
  });

  test('changeAccountPassword fullReset posts rotate-root', async () => {
    const { ctx, keylog } = await signedCtx('old-pass-word');
    await changeAccountPassword(ctx, {
      fullReset: true,
      oldPassword: 'old-pass-word',
      newPassword: 'new-pass-word',
    });
    expect(JSON.parse(keylog()).bytes).toBeTruthy();
  });

  test('enableTotp verifies the code then posts set-totp', async () => {
    const { ctx, keylog } = await signedCtx('old-pass-word');
    const secret = generateTotpSecret();
    const code = totpCode(secret, Math.floor(Date.now() / 1000));
    const outcome = await enableTotp(ctx, { password: 'old-pass-word', secret, code });
    expect(outcome.secretBase32).toBe(encodeBase32(secret));
    expect(outcome.otpauthUri).toContain('otpauth://totp/');
    expect(JSON.parse(keylog()).bytes).toBeTruthy();
  });

  test('enableTotp rejects a bad code before writing keylog', async () => {
    const { ctx, keylog } = await signedCtx('old-pass-word');
    await expect(
      enableTotp(ctx, {
        password: 'old-pass-word',
        secret: generateTotpSecret(),
        code: '000000',
      })
    ).rejects.toBeInstanceOf(AuthError);
    expect(keylog()).toBe('');
  });

  test('disableTotp and removePasskey append signed records', async () => {
    const { ctx, keylog } = await signedCtx('old-pass-word');
    await disableTotp(ctx, 'old-pass-word');
    expect(JSON.parse(keylog()).bytes).toBeTruthy();
    await removePasskey(ctx, 'cred-1', 'old-pass-word');
    expect(JSON.parse(keylog()).bytes).toBeTruthy();
  });
});

describe('confirmTotpCode', () => {
  test('re-prompts on a TTY with the same secret', async () => {
    const secret = generateTotpSecret();
    const nowSec = 1_700_000_000;
    const good = totpCode(secret, nowSec);
    const prompts = ['000000', good];
    const warnings: string[] = [];
    const code = await confirmTotpCode({
      secret,
      preset: null,
      interactive: true,
      secretBase32: encodeBase32(secret),
      nowSec,
      prompt: async () => prompts.shift() ?? '',
      warn: (message) => warnings.push(message),
    });
    expect(code).toBe(good);
    expect(warnings[0]).toContain('same secret');
    expect(prompts).toEqual([]);
  });

  test('a non-TTY miss tells the user to reuse the printed secret', async () => {
    const error = await confirmTotpCode({
      secret: generateTotpSecret(),
      preset: null,
      interactive: false,
      secretBase32: 'NB2W45DFOIZA',
      prompt: async () => '000000',
    }).catch((err) => err);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).hint).toContain('--totp-secret NB2W45DFOIZA');
  });

  test('a bad --code does not retry', async () => {
    const secret = generateTotpSecret();
    const error = await confirmTotpCode({
      secret,
      preset: '000000',
      interactive: true,
      secretBase32: encodeBase32(secret),
      prompt: async () => {
        throw new Error('should not prompt');
      },
    }).catch((err) => err);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).hint).toContain(encodeBase32(secret));
  });
});
