// 「通行密钥需验证两次」的常驻提示，摆在「确认加入」按钮旁。
//
// 凭据框里也有同一句，但生成加入码时刚用过的 passkey 还在 5 分钟复用窗口里，点确认不会再弹框，
// 那一句用户根本看不到——所以按钮旁必须自己说。设置页的待确认行与接入面板共用这一个组件。

import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { rememberedSignerKind, subscribeRememberedSigner } from './credential-prompt';
import type { RecordSigner } from './key-log-actions';

/** 一次确认的验证次数取决于这两样，由挂载点给出。 */
export interface PasskeyTwiceContext {
  /** 这次确认要签两条记录（中继模式：准入 + 下发成员密钥）。 */
  twoStep: boolean;
  /** 当前入口有可用的 passkey（`prompt.passkeys` 非空）。 */
  passkeysAvailable: boolean;
}

/**
 * 这次确认会不会连着做两次 passkey 验证。
 *
 * 复用窗口里有签名者就直接用它（不弹框）：是 passkey 才会验证两次，根钥一次签完两条。
 * 窗口是空的才轮到用户在凭据框里选，入口有 passkey 就可能选到它。
 */
export function passkeyTwiceExpected(
  context: PasskeyTwiceContext,
  remembered: RecordSigner['kind'] | null
): boolean {
  if (!context.twoStep) return false;
  if (remembered) return remembered === 'passkey';
  return context.passkeysAvailable;
}

export function PasskeyTwiceHint({
  context,
  testId,
  className = 'text-xs text-muted-foreground',
}: {
  context: PasskeyTwiceContext;
  testId: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const remembered = useSyncExternalStore(
    subscribeRememberedSigner,
    rememberedSignerKind,
    rememberedSignerKind
  );
  if (!passkeyTwiceExpected(context, remembered)) return null;
  return (
    <p className={className} data-testid={testId}>
      {t('auth.credential.passkeyTwice')}
    </p>
  );
}
