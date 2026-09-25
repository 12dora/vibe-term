// TOTP 设置草稿：确认成功或显式放弃之前，二维码（密钥）不能换。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@vibeterm/api-client';
import { AuthApi } from '@vibeterm/api-client/auth/index';
import {
  decodeBase64url,
  decodeKeyLogRecord,
  decodeSetTotpPayload,
  decryptTotpSecret,
  deriveSeed,
  deriveTotpKey,
  encodeBase64url,
  totpCode,
} from '@vibeterm/shared/auth';
import { TotpEnrollment } from './account-security-totp';

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const HEAD_SEQ = 4;
const EPOCH = 3;
const UID = 'alice';
const PASSWORD = 'old-secret';
const NOW_SEC = 1_700_000_000;

function mockApi(keylogStatuses: number[] = []) {
  const posted: Uint8Array[] = [];
  let headCalls = 0;
  let releaseHead: (() => void) | null = null;
  const holdHead = { enabled: false };
  const client = new ApiClient('', async (url, init) => {
    if (url === '/api/auth/keylog/head') {
      headCalls += 1;
      if (holdHead.enabled) {
        await new Promise<void>((resolve) => {
          releaseHead = resolve;
        });
      }
      return Response.json({
        seq: HEAD_SEQ,
        hash: encodeBase64url(new Uint8Array(32).fill(0x66)),
        rootEpoch: EPOCH,
        uid: UID,
      });
    }
    if (url === '/api/auth/keylog') {
      const body = JSON.parse(String(init?.body)) as { bytes: string };
      posted.push(decodeBase64url(body.bytes));
      return new Response('', { status: keylogStatuses[posted.length - 1] ?? 200 });
    }
    return new Response('not found', { status: 404 });
  });
  return {
    api: new AuthApi(client),
    posted,
    holdHead,
    get headCalls() {
      return headCalls;
    },
    release() {
      releaseHead?.();
    },
  };
}

function wrongCode(secret: Uint8Array): string {
  const valid = new Set([-1, 0, 1].map((step) => totpCode(secret, NOW_SEC + step * 30)));
  for (let n = 0; ; n += 1) {
    const candidate = String(n).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
}

async function writtenSecret(bytes: Uint8Array): Promise<Uint8Array> {
  const record = decodeKeyLogRecord(bytes);
  const seed = await deriveSeed(PASSWORD, {
    salt: decodeBase64url(KDF_JSON.salt),
    memory_kib: KDF_JSON.memory_kib,
    iterations: KDF_JSON.iterations,
    parallelism: KDF_JSON.parallelism,
  });
  return decryptTotpSecret(deriveTotpKey(seed, UID, EPOCH), decodeSetTotpPayload(record.payload), {
    uid: UID,
    root_epoch: EPOCH,
    seq: BigInt(HEAD_SEQ) + 1n,
  });
}

describe('TotpEnrollment', () => {
  test('验证码错误后草稿与二维码不变，再次开始也复用同一密钥，随后正确的码能完成设置', async () => {
    const mock = mockApi();
    const enrollment = new TotpEnrollment();
    const first = enrollment.start({ uid: UID, issuer: 'VibeTerm' });
    const uri = first.otpauthUri;
    const expected = first.secret.slice();

    const failed = await enrollment.confirm({
      api: mock.api,
      password: PASSWORD,
      currentKdfParams: KDF_JSON,
      code: wrongCode(expected),
      now: NOW_SEC,
    });
    expect(failed).toEqual({ ok: false, code: 'TOTP_INVALID' });
    expect(mock.posted).toHaveLength(0);
    expect(enrollment.draft?.otpauthUri).toBe(uri);
    expect(enrollment.draft?.secret).toEqual(expected);
    expect(enrollment.start({ uid: UID, issuer: 'VibeTerm' }).otpauthUri).toBe(uri);

    const ok = await enrollment.confirm({
      api: mock.api,
      password: PASSWORD,
      currentKdfParams: KDF_JSON,
      code: totpCode(expected, NOW_SEC),
      now: NOW_SEC,
    });
    expect(ok.ok && ok.result.ok).toBe(true);
    expect(mock.posted).toHaveLength(1);
    expect(await writtenSecret(mock.posted[0])).toEqual(expected);
    expect(enrollment.draft).toBeNull();
    expect(first.secret.every((byte) => byte === 0)).toBe(true);
  }, 20000);

  test('key-log 拒绝时保留草稿，重试写入的仍是同一密钥', async () => {
    const mock = mockApi([409]);
    const enrollment = new TotpEnrollment();
    const draft = enrollment.start({ uid: UID });
    const expected = draft.secret.slice();
    const input = {
      api: mock.api,
      password: PASSWORD,
      currentKdfParams: KDF_JSON,
      code: totpCode(expected, NOW_SEC),
      now: NOW_SEC,
    };

    const rejected = await enrollment.confirm(input);
    expect(rejected.ok && !rejected.result.ok).toBe(true);
    expect(enrollment.draft?.otpauthUri).toBe(draft.otpauthUri);

    const retried = await enrollment.confirm(input);
    expect(retried.ok && retried.result.ok).toBe(true);
    expect(await writtenSecret(mock.posted[1])).toEqual(expected);
  }, 20000);

  test('放弃后清零密钥，下一次开始才换新二维码', () => {
    const enrollment = new TotpEnrollment();
    const first = enrollment.start({ uid: UID });
    const uri = first.otpauthUri;
    enrollment.discard();
    expect(enrollment.draft).toBeNull();
    expect(first.secret.every((byte) => byte === 0)).toBe(true);
    expect(enrollment.start({ uid: UID }).otpauthUri).not.toBe(uri);
  });

  test('确认途中放弃（关面板）不会把清零后的密钥写进 key-log', async () => {
    const mock = mockApi();
    mock.holdHead.enabled = true;
    const enrollment = new TotpEnrollment();
    const expected = enrollment.start({ uid: UID }).secret.slice();
    const pending = enrollment.confirm({
      api: mock.api,
      password: PASSWORD,
      currentKdfParams: KDF_JSON,
      code: totpCode(expected, NOW_SEC),
      now: NOW_SEC,
    });
    while (mock.headCalls === 0) await Bun.sleep(1);
    enrollment.discard();
    mock.release();
    await pending;
    expect(await writtenSecret(mock.posted[0])).toEqual(expected);
  }, 20000);
});
