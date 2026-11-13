// 吊销落账后刷新中继令牌：沿用吊销的签名者；通行密钥补一次凭据；失败只给一行错误与重试。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import {
  decodeBase64url,
  deriveSeed,
  encodeBase64url,
  rootKeyFromSeed,
} from '@vibeterm/shared/auth';
import { toast } from 'sonner';
import { type RekeyDeps, reportRekey, revokeAndRekey } from './relay-rekey-after-revoke';
import type { ResolvedMode } from './types';

const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};
const URL_A = 'https://relay-a.example.com';

async function rootSigner(): Promise<RecordSigner> {
  const seed = await deriveSeed('pw', {
    salt: decodeBase64url(KDF_JSON.salt),
    memory_kib: KDF_JSON.memory_kib,
    iterations: KDF_JSON.iterations,
    parallelism: KDF_JSON.parallelism,
  });
  return { kind: 'root', rootKey: rootKeyFromSeed(seed) };
}

const PASSKEY: RecordSigner = { kind: 'passkey', credentialId: 'cred' };

let seen = 0;

function forgetToasts(): void {
  seen = toast.getToasts().length;
}

function newToasts(): Array<{ title?: unknown; action?: { label: string } }> {
  return toast.getToasts().slice(seen) as Array<{ title?: unknown; action?: { label: string } }>;
}

function messages(): string[] {
  return newToasts().map((row) => String(row.title));
}

beforeEach(forgetToasts);

async function depsOf(options: {
  signers: RecordSigner[];
  mode?: 'relay' | 'none';
}) {
  const probe = await rootSigner();
  const rootPublicKey = probe.kind === 'root' ? encodeBase64url(probe.rootKey.publicKey) : '';
  const enrolled: string[] = [];
  const statusCalls: number[] = [];
  const prompts: Array<string | undefined> = [];
  const relayApi = {
    status: () => {
      statusCalls.push(1);
      return Promise.resolve({
        mode: options.mode ?? 'relay',
        relays: options.mode === 'none' ? [] : [{ url: URL_A, priority: 0 }],
      });
    },
    enrollPassword: () => Promise.resolve({ known: false, password: null, passwordEpoch: null }),
    proofMaterial: (url: string) =>
      Promise.resolve({
        url,
        relayHost: new URL(url).host,
        ts: 1_700_000_000_000,
        maxSkewMs: 300_000,
        rootPublicKey,
        rootEpoch: 3,
      }),
    readmitPrepare: () => Promise.resolve({ rootEpoch: 3, entries: [] }),
    enroll: (body: { url: string }) => {
      enrolled.push(body.url);
      return Promise.resolve({
        tenantId: 'cd'.repeat(16),
        token: 'dA',
        passwordEpoch: 1,
        payload: encodeBase64url(new Uint8Array([1])),
        payloadHash: 'h',
      });
    },
  } as unknown as RelayTenantApi;
  const queue = [...options.signers];
  const prompt = {
    withSigner: (async (fn: (signer: RecordSigner) => unknown, opts?: { purpose?: string }) => {
      prompts.push(opts?.purpose);
      const signer = queue.shift();
      return signer ? fn(signer) : null;
    }) as CredentialPromptHandle['withSigner'],
  };
  const deps: RekeyDeps = {
    api: {
      keyLogHead: () =>
        Promise.resolve({ seq: 4, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
      appendKeyLog: () => Promise.resolve({ ok: true, hubAck: true }),
    } as unknown as AuthApi,
    mode: {
      uid: 'u1',
      rootEpoch: 3,
      kdfParams: KDF_JSON,
      rootPublicKey,
    } as unknown as ResolvedMode,
    t: (key, opts) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
    prompt,
    relayApi,
  };
  return { deps, enrolled, statusCalls, prompts };
}

describe('revokeAndRekey', () => {
  test('吊销落账：用同一把根钥签名者接着刷新令牌，不再提示', async () => {
    const { deps, enrolled, prompts } = await depsOf({ signers: [] });
    const signer = await rootSigner();
    const outcome = await revokeAndRekey(deps, signer, async () => ({
      value: 'attempt',
      landed: true,
    }));
    expect(outcome).toEqual({ value: 'attempt', rekey: { ok: true } });
    expect(enrolled).toEqual([URL_A]);
    expect(prompts).toEqual([]);
  });

  test('吊销没落账：不碰中继', async () => {
    const { deps, enrolled, statusCalls } = await depsOf({ signers: [] });
    const outcome = await revokeAndRekey(deps, await rootSigner(), async () => ({
      value: 'failed',
      landed: false,
    }));
    expect(outcome.rekey).toBeNull();
    expect(statusCalls).toEqual([]);
    expect(enrolled).toEqual([]);
  });

  test('通行密钥吊销：回调内不发 enroll，结论要求根密码', async () => {
    const { deps, enrolled } = await depsOf({ signers: [] });
    const outcome = await revokeAndRekey(deps, PASSKEY, async () => ({
      value: 'attempt',
      landed: true,
    }));
    expect(outcome.rekey).toEqual({ ok: false, code: 'RELAY_REKEY_NEEDS_ROOT', urls: [URL_A] });
    expect(enrolled).toEqual([]);
  });
});

describe('reportRekey', () => {
  test('成功或无事可做：不提示', async () => {
    const { deps, prompts } = await depsOf({ signers: [] });
    await reportRekey(deps, null);
    await reportRekey(deps, { ok: true });
    expect(prompts).toEqual([]);
    expect(messages()).toEqual([]);
  });

  test('要根密码：补一次凭据，拿到根钥后刷新并提示完成', async () => {
    const { deps, enrolled, prompts } = await depsOf({ signers: [await rootSigner()] });
    await reportRekey(deps, { ok: false, code: 'RELAY_REKEY_NEEDS_ROOT', urls: [URL_A] });
    expect(prompts).toEqual(['revoke']);
    expect(enrolled).toEqual([URL_A]);
    expect(messages()).toEqual(['relay.tenant.rekey.done']);
  });

  test('补凭据时又选了通行密钥或取消：一行错误，不发 enroll', async () => {
    const { deps, enrolled } = await depsOf({ signers: [PASSKEY] });
    await reportRekey(deps, { ok: false, code: 'RELAY_REKEY_NEEDS_ROOT', urls: [URL_A] });
    expect(enrolled).toEqual([]);
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toContain('relay.tenant.rekey.failed');

    forgetToasts();
    const cancelled = await depsOf({ signers: [] });
    await reportRekey(cancelled.deps, {
      ok: false,
      code: 'RELAY_REKEY_NEEDS_ROOT',
      urls: [URL_A],
    });
    expect(messages()).toHaveLength(1);
  });

  test('刷新失败：一行错误，带重试；吊销不受影响', async () => {
    const { deps, prompts } = await depsOf({ signers: [] });
    await reportRekey(deps, { ok: false, code: 'RELAY_UNREACHABLE', urls: [URL_A] });
    expect(prompts).toEqual([]);
    expect(messages()).toHaveLength(1);
    const [row] = newToasts();
    expect(row.action?.label).toBe('common.retry');
  });
});
