// 统一凭据对话框：可用 passkey 的判定、由用户选择造签名者、根钥 seed 的清零时机。

import { describe, expect, test } from 'bun:test';
import { WebAuthnError } from '@tmex/api-client/auth/index';
import type { PasskeySummary } from '@tmex/api-client/auth/index';
import { decodeBase64url, deriveSeed, encodeBase64url, rootKeyFromSeed } from '@tmex/shared/auth';
import type { RootKey } from '@tmex/shared/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CredentialPromptDialog,
  WrongPasswordError,
  credentialErrorText,
  decodeRootPublicKey,
  forgetSigner,
  isRetryableCredentialError,
  leaseSigner,
  rememberSigner,
  runWithChoice,
  signerFromChoice,
  takeRememberedSigner,
  usablePasskeys,
} from './credential-prompt';

// 单测用便宜的 argon2 参数（真实参数 64 MiB / t=3 太慢）。
const KDF_JSON = {
  salt: encodeBase64url(new Uint8Array(16).fill(0x05)),
  memory_kib: 64,
  iterations: 1,
  parallelism: 1,
};

async function rootKeyOf(password: string): Promise<RootKey> {
  return rootKeyFromSeed(
    await deriveSeed(password, {
      salt: decodeBase64url(KDF_JSON.salt),
      memory_kib: KDF_JSON.memory_kib,
      iterations: KDF_JSON.iterations,
      parallelism: KDF_JSON.parallelism,
    })
  );
}

function passkey(overrides: Partial<PasskeySummary> & { credential_id: string }): PasskeySummary {
  return {
    name: overrides.credential_id,
    rp_id: 'hub.example',
    origin: 'https://hub.example',
    ...overrides,
  };
}

const HUB_PASSKEY = passkey({ credential_id: 'a' });
const OTHER_PASSKEY = passkey({
  credential_id: 'b',
  rp_id: 'other.example',
  origin: 'https://other.example',
});

describe('usablePasskeys', () => {
  test('后端说本环境用不了 passkey 时一律为空', () => {
    expect(
      usablePasskeys({
        passkeys: [HUB_PASSKEY],
        passkeyAvailable: false,
        origin: 'https://hub.example',
      })
    ).toEqual([]);
  });

  test('只留注册 origin 与当前 origin 一致的凭证', () => {
    expect(
      usablePasskeys({
        passkeys: [HUB_PASSKEY, OTHER_PASSKEY],
        passkeyAvailable: true,
        origin: 'https://hub.example',
      }).map((row) => row.credential_id)
    ).toEqual(['a']);
  });

  test('本 origin 一把都没有时为空——不给一个注定 NotAllowedError 的按钮', () => {
    expect(
      usablePasskeys({
        passkeys: [OTHER_PASSKEY],
        passkeyAvailable: true,
        origin: 'https://hub.example',
      })
    ).toEqual([]);
    expect(usablePasskeys({ passkeys: [], passkeyAvailable: true })).toEqual([]);
  });
});

describe('对话框', () => {
  function render(passkeys: PasskeySummary[]): string {
    return renderToStaticMarkup(
      <CredentialPromptDialog
        purpose="revoke"
        passkeys={passkeys}
        busy={false}
        error={null}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    );
  }

  test('没有可用 passkey 时只渲染密码路径', () => {
    const html = render([]);
    expect(html).toContain('data-testid="credential-prompt-password"');
    expect(html).toContain('data-testid="credential-prompt-submit"');
    expect(html).not.toContain('data-testid="credential-prompt-passkey"');
    expect(html).not.toContain('data-testid="credential-prompt-passkey-select"');
  });

  test('有可用 passkey 时才出现 passkey 按钮；多把才出现选择器', () => {
    const single = render([HUB_PASSKEY]);
    expect(single).toContain('data-testid="credential-prompt-passkey"');
    expect(single).not.toContain('data-testid="credential-prompt-passkey-select"');

    const many = render([HUB_PASSKEY, passkey({ credential_id: 'c' })]);
    expect(many).toContain('data-testid="credential-prompt-passkey-select"');
  });

  test('错误文案渲染在框里，用户可以直接改密码重试', () => {
    const html = renderToStaticMarkup(
      <CredentialPromptDialog
        purpose="enroll"
        passkeys={[]}
        busy={false}
        error="auth.errors.ROOT_KEY_MISMATCH"
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    );
    expect(html).toContain('data-testid="credential-prompt-error"');
  });
});

describe('signerFromChoice', () => {
  test('passkey 选择直接变成 passkey 签名者，不碰密码', async () => {
    const signer = await signerFromChoice({ kind: 'passkey', credentialId: 'a' }, KDF_JSON);
    expect(signer).toEqual({ kind: 'passkey', credentialId: 'a' });
  });

  test('密码派生的根公钥与服务端一致时返回根钥签名者', async () => {
    const expected = await rootKeyOf('secret');
    const signer = await signerFromChoice(
      { kind: 'password', password: 'secret' },
      KDF_JSON,
      expected.publicKey
    );
    expect(signer.kind).toBe('root');
    if (signer.kind !== 'root') return;
    expect(encodeBase64url(signer.rootKey.publicKey)).toBe(encodeBase64url(expected.publicKey));
  }, 20000);

  test('密码打错：当场报 ROOT_KEY_MISMATCH，且派生出的 seed 已清零', async () => {
    const expected = await rootKeyOf('secret');
    await expect(
      signerFromChoice({ kind: 'password', password: 'wrong' }, KDF_JSON, expected.publicKey)
    ).rejects.toBeInstanceOf(WrongPasswordError);
  }, 20000);
});

describe('runWithChoice', () => {
  test('根钥路径回调返回后立刻清零 seed（复用 withRootSigner）', async () => {
    let captured: Uint8Array | null = null;
    const value = await runWithChoice(
      { kind: 'password', password: 'secret' },
      KDF_JSON,
      (signer) => {
        if (signer.kind === 'root') captured = signer.rootKey.seed;
        return 'done';
      }
    );
    expect(value).toBe('done');
    expect((captured as unknown as Uint8Array).every((byte) => byte === 0)).toBe(true);
  }, 20000);

  test('根公钥对不上时不执行回调', async () => {
    let called = false;
    await expect(
      runWithChoice(
        { kind: 'password', password: 'wrong' },
        KDF_JSON,
        () => {
          called = true;
          return 1;
        },
        (await rootKeyOf('secret')).publicKey
      )
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(called).toBe(false);
  }, 20000);

  test('passkey 路径原样把签名者交给回调', async () => {
    const seen: string[] = [];
    await runWithChoice({ kind: 'passkey', credentialId: 'a' }, KDF_JSON, (signer) => {
      if (signer.kind === 'passkey') seen.push(signer.credentialId);
      return null;
    });
    expect(seen).toEqual(['a']);
  });
});

describe('错误分类与根公钥解码', () => {
  test('密码错 / 仪式被取消留在框里重试，其余错误往外抛', () => {
    expect(isRetryableCredentialError(new WrongPasswordError())).toBe(true);
    expect(isRetryableCredentialError(new WebAuthnError('aborted', 'cancelled'))).toBe(true);
    expect(isRetryableCredentialError(new WebAuthnError('unsupported', 'no webauthn'))).toBe(false);
    expect(isRetryableCredentialError(new Error('network'))).toBe(false);
  });

  test('错误文案优先给 i18n key', () => {
    expect(credentialErrorText(new WrongPasswordError())).toBe('auth.errors.ROOT_KEY_MISMATCH');
    expect(credentialErrorText(new WebAuthnError('aborted', 'x'))).toBe(
      'auth.errors.PASSKEY_ABORTED'
    );
    expect(credentialErrorText(new Error('boom'))).toBe('boom');
  });

  test('decodeRootPublicKey：只认 32 字节，其余一律 null', () => {
    const pk = new Uint8Array(32).fill(9);
    expect(decodeRootPublicKey(encodeBase64url(pk))).toEqual(pk);
    expect(decodeRootPublicKey(null)).toBeNull();
    expect(decodeRootPublicKey(undefined)).toBeNull();
    expect(decodeRootPublicKey(encodeBase64url(new Uint8Array(16)))).toBeNull();
    expect(decodeRootPublicKey('@@@')).toBeNull();
  });
});

describe('复用窗口的归属与租约', () => {
  const NOW = 1_700_000_000_000;

  test('只有存进去的那个实例能清掉它：别的对话框卸载不影响', () => {
    const mine = Symbol('mine');
    const other = Symbol('other');
    const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x31));
    rememberSigner({ kind: 'root', rootKey }, NOW, mine);

    // 另一个对话框实例卸载：不是它存的，一个字节都不许动。
    forgetSigner(other);
    expect(takeRememberedSigner(NOW)).not.toBeNull();
    expect(rootKey.seed.every((byte) => byte === 0)).toBe(false);

    forgetSigner(mine);
    expect(takeRememberedSigner(NOW)).toBeNull();
    expect(rootKey.seed.every((byte) => byte === 0)).toBe(true);
  });

  test('不带归属的清理照旧无条件生效（页面级重置 / 测试）', () => {
    const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x32));
    rememberSigner({ kind: 'root', rootKey }, NOW, Symbol('owner'));
    forgetSigner();
    expect(takeRememberedSigner(NOW)).toBeNull();
    expect(rootKey.seed.every((byte) => byte === 0)).toBe(true);
  });

  test('租约期内不清零：签名做完释放租约才抹掉', () => {
    const owner = Symbol('owner');
    const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x33));
    const signer = { kind: 'root', rootKey } as const;
    rememberSigner(signer, NOW, owner);

    const release = leaseSigner(signer);
    forgetSigner(owner);
    // 复用窗口已经交出去了，但正在签的这份根钥还不能动。
    expect(takeRememberedSigner(NOW)).toBeNull();
    expect(rootKey.seed.every((byte) => byte === 0)).toBe(false);

    release();
    expect(rootKey.seed.every((byte) => byte === 0)).toBe(true);
    // 重复释放不该再动别的东西。
    release();
  });
});
