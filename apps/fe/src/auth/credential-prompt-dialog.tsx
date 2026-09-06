// 凭据对话框的渲染面：密码 / passkey 两条路径的表单，以及它挂在哪。
//
// 取签名者的流程与复用窗口在 ./credential-prompt，本文件只负责这一屏。

import type { PasskeySummary } from '@vibeterm/api-client/auth/index';
import { Button } from '@vibeterm/ui/button';
import { Dialog, DialogContent } from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { Fingerprint, KeyRound, Loader2 } from 'lucide-react';
import { type RefObject, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CredentialChoice, CredentialPurpose } from './credential-prompt';

export interface CredentialPromptDialogProps {
  purpose: CredentialPurpose;
  /** 已按 origin 过滤过的可用凭证；为空则只渲染密码路径。 */
  passkeys: PasskeySummary[];
  busy: boolean;
  error: string | null;
  onSubmit: (choice: CredentialChoice) => void;
  onCancel: () => void;
}

/**
 * 有没有真实 DOM：浏览器里走 base-ui 的嵌套对话框，静态渲染（无 `document`）内联输出。
 *
 * 内联输出是给服务端静态渲染与单测用的——本页的用例正是靠静态渲染断言「passkey 选项只在
 * 允许时出现」，而 base-ui 的 Dialog 在没有 DOM 时什么都不输出。
 */
export function credentialPromptContainer(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.body;
}

/**
 * 关闭请求（Escape / 点遮罩）是否算「取消」：忙碌中不接受，与「取消」按钮的禁用态一致。
 * `open` 恒为受控的 `true`，所以只有请求关闭时才会走到这里。
 */
export function credentialPromptCloseRequest(open: boolean, busy: boolean): boolean {
  return !open && !busy;
}

/**
 * 凭据框。
 *
 * 浏览器里是一个**嵌套的 base-ui Dialog**：既可能开在侧栏 Sheet（账号安全）里，也可能开在
 * 一个已 portal 到 body 的 AlertDialog（离开中继）之上。自己拿 `createPortal` 挂 body 两头
 * 都不对——挂出去就脱离了 Sheet 的焦点环，Tab 根本走不到密码框；留在原地又会被别的遮罩盖住。
 * 交给 base-ui：嵌套对话框的焦点接管、Escape、关闭后焦点归位都由它负责，层级用 z-60 压住
 * 其余 z-50 的遮罩。
 */
export function CredentialPromptDialog(props: CredentialPromptDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fields = <CredentialPromptFields {...props} passwordRef={passwordRef} titleId={titleId} />;
  const { busy, onCancel } = props;

  // 静态渲染没有 DOM，base-ui 的 Dialog 一个字节都不输出：内联铺一层同样的遮罩兜底。
  if (credentialPromptContainer() === null) {
    return (
      <div
        className="vibeterm-fade fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
        data-testid="credential-prompt"
      >
        <div className="vibeterm-scale-in flex w-full max-w-sm flex-col gap-3 rounded-xl border border-border bg-background p-4 shadow-lg">
          {fields}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open
      // 点遮罩不算取消：密码输到一半误点一下就得从头再来。Escape 仍然关（转成取消）。
      disablePointerDismissal
      onOpenChange={(open) => {
        if (credentialPromptCloseRequest(open, busy)) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={passwordRef}
        aria-labelledby={titleId}
        data-testid="credential-prompt"
        className="z-[60] flex flex-col gap-3"
      >
        {fields}
      </DialogContent>
    </Dialog>
  );
}

/** 表单本体：两种挂法共用同一棵子树，密码与所选凭证的状态跟着它走。 */
function CredentialPromptFields({
  purpose,
  passkeys,
  busy,
  error,
  onSubmit,
  onCancel,
  passwordRef,
  titleId,
}: CredentialPromptDialogProps & {
  passwordRef: RefObject<HTMLInputElement | null>;
  titleId: string;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [credentialId, setCredentialId] = useState(passkeys[0]?.credential_id ?? '');

  const canUsePasskey = passkeys.length > 0;
  const selected = canUsePasskey
    ? (passkeys.find((row) => row.credential_id === credentialId) ?? passkeys[0])
    : null;

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <h2 id={titleId} className="text-sm font-semibold">
          {t('auth.credential.title')}
        </h2>
        <p className="text-xs text-muted-foreground" data-testid="credential-prompt-purpose">
          {t(`auth.credential.purpose.${purpose}`)}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">{t('auth.credential.hint')}</p>

      <Input
        ref={passwordRef}
        type="password"
        autoComplete="current-password"
        placeholder={t('auth.security.currentPassword')}
        value={password}
        data-testid="credential-prompt-password"
        onChange={(event) => setPassword(event.target.value)}
      />

      {/* 播报节点常驻：`empty:hidden` 会把它从可访问性树里摘掉，播报会时灵时不灵。
          sr-only 是 absolute 定位，空着也不占 flex gap；可见的报错块另外条件渲染。 */}
      <output className="sr-only" aria-live="polite">
        {error ? t(error, { defaultValue: error }) : ''}
      </output>
      {error ? (
        <p className="vibeterm-fade text-xs text-destructive" data-testid="credential-prompt-error">
          {t(error, { defaultValue: error })}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !password}
          onClick={() => onSubmit({ kind: 'password', password })}
          data-testid="credential-prompt-submit"
        >
          {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <KeyRound />}
          {t('auth.credential.usePassword')}
        </Button>
        {canUsePasskey && selected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => onSubmit({ kind: 'passkey', credentialId: selected.credential_id })}
            data-testid="credential-prompt-passkey"
          >
            <Fingerprint />
            {t('auth.credential.usePasskey')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          data-testid="credential-prompt-cancel"
        >
          {t('common.cancel')}
        </Button>
      </div>

      {canUsePasskey && passkeys.length > 1 ? (
        <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
          {t('auth.credential.passkeySelect')}
          <select
            className="rounded-md border border-border bg-background p-1 text-xs"
            value={selected?.credential_id ?? ''}
            data-testid="credential-prompt-passkey-select"
            onChange={(event) => setCredentialId(event.target.value)}
          >
            {passkeys.map((row) => (
              <option key={row.credential_id} value={row.credential_id}>
                {row.name || row.credential_id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </>
  );
}
