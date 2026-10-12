// 确认按钮旁的「通行密钥需验证两次」：有第二步、且将要用的签名者是 passkey 时才出现。
// 无 DOM 测试环境，用 react-dom/server 静态渲染。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rootKeyFromSeed } from '@vibeterm/shared/auth';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  forgetSigner,
  rememberSigner,
  rememberedSignerKind,
  subscribeRememberedSigner,
} from './credential-prompt';
import {
  type PasskeyTwiceContext,
  PasskeyTwiceHint,
  passkeyTwiceExpected,
} from './passkey-twice-hint';

const NOW = 1_700_000_000_000;
const TWO_STEP_PASSKEYS: PasskeyTwiceContext = { twoStep: true, passkeysAvailable: true };
const TWO_STEP_PASSWORD: PasskeyTwiceContext = { twoStep: true, passkeysAvailable: false };

function rememberRoot(): void {
  rememberSigner({ kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(0x21)) }, NOW);
}

function rememberPasskey(): void {
  rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, NOW);
}

function render(context: PasskeyTwiceContext): string {
  return renderToStaticMarkup(<PasskeyTwiceHint context={context} testId="hint" />);
}

beforeEach(() => {
  forgetSigner();
});

afterEach(() => {
  forgetSigner();
});

describe('passkeyTwiceExpected', () => {
  test('复用窗口里是 passkey：点确认不弹框，直接连做两次验证', () => {
    expect(passkeyTwiceExpected(TWO_STEP_PASSKEYS, 'passkey')).toBe(true);
    // 窗口里那把说了算：入口此刻列不出 passkey 也一样。
    expect(passkeyTwiceExpected(TWO_STEP_PASSWORD, 'passkey')).toBe(true);
  });

  test('复用窗口里是根钥：一次签完两条，不提示', () => {
    expect(passkeyTwiceExpected(TWO_STEP_PASSKEYS, 'root')).toBe(false);
  });

  test('窗口是空的：入口有可用 passkey 才提示，只能用密码不提示', () => {
    expect(passkeyTwiceExpected(TWO_STEP_PASSKEYS, null)).toBe(true);
    expect(passkeyTwiceExpected(TWO_STEP_PASSWORD, null)).toBe(false);
  });

  test('没有第二步：无论用什么凭据都只验证一次', () => {
    const singleStep = { twoStep: false, passkeysAvailable: true };
    expect(passkeyTwiceExpected(singleStep, 'passkey')).toBe(false);
    expect(passkeyTwiceExpected(singleStep, null)).toBe(false);
  });
});

describe('PasskeyTwiceHint', () => {
  test('生成加入码时刚用过 passkey（还在复用窗口里）：按钮旁常驻一句', () => {
    rememberPasskey();
    const html = render(TWO_STEP_PASSWORD);
    expect(html).toContain('data-testid="hint"');
    expect(html).toContain('auth.credential.passkeyTwice');
  });

  test('复用窗口里是根钥：不渲染', () => {
    rememberRoot();
    expect(render(TWO_STEP_PASSKEYS)).toBe('');
  });

  test('窗口为空：跟着入口有没有 passkey 走', () => {
    expect(render(TWO_STEP_PASSKEYS)).toContain('data-testid="hint"');
    expect(render(TWO_STEP_PASSWORD)).toBe('');
  });

  test('没有第二步：不渲染', () => {
    rememberPasskey();
    expect(render({ twoStep: false, passkeysAvailable: true })).toBe('');
  });
});

describe('复用窗口的订阅', () => {
  test('存入、换人、清零都会通知，读到的是当下那把的种类', () => {
    const seen: (string | null)[] = [];
    const stop = subscribeRememberedSigner(() => seen.push(rememberedSignerKind()));

    rememberPasskey();
    expect(rememberedSignerKind()).toBe('passkey');
    rememberRoot();
    expect(rememberedSignerKind()).toBe('root');
    forgetSigner();
    expect(rememberedSignerKind()).toBeNull();
    // 换人时先清旧的再存新的；最后一次通知永远对应当前状态。
    expect(seen).toEqual(['passkey', null, 'root', null]);

    stop();
    rememberPasskey();
    expect(seen).toHaveLength(4);
  });
});
