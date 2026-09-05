import {
  type TotpSetupDraft,
  beginTotpSetup,
  clearTotp,
  confirmTotpSetup,
} from '@/auth/account-security-actions';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { AuthApi, PasskeySummary } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { OtpInput } from '@tmex/ui/otp-input';
import { Loader2 } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { securityActionErrorText } from '../account-security-password';
import { Feedback, Section } from './section';
import type { ResolvedMode, SecurityActionFeedback } from './types';

export function TotpSection({
  mode,
  api,
  uid,
  passkeys,
  prompt,
  onDone,
  feedback,
  publishFeedback,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  passkeys: PasskeySummary[];
  prompt: CredentialPromptHandle;
  onDone: () => void;
  feedback: SecurityActionFeedback | null;
  publishFeedback: (next: SecurityActionFeedback | null) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownFeedback = feedback?.section === 'totp' ? feedback : null;
  // 第一阶段的草稿：密钥只在内存，用户确认验证码之前不会写任何 key-log 记录。
  const [draft, setDraft] = useState<TotpSetupDraft | null>(null);
  const [code, setCode] = useState('');

  // 组件卸载时清掉未确认的密钥字节。
  useEffect(
    () => () => {
      draft?.secret.fill(0);
    },
    [draft]
  );

  const begin = useCallback(() => {
    setError(null);
    publishFeedback(null);
    setCode('');
    setDraft(beginTotpSetup({ uid, issuer: 'tmex' }));
  }, [publishFeedback, uid]);

  const confirm = useCallback(async () => {
    setError(null);
    if (!draft) return;
    if (!password) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError(t('auth.security.totpCodeRequired'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await confirmTotpSetup({
        api,
        uid,
        password,
        currentKdfParams: mode.kdfParams,
        secret: draft.secret,
        code,
      });
      setPassword('');
      if (!outcome.ok) {
        setError(t('auth.errors.TOTP_INVALID'));
        return;
      }
      if (!outcome.result.ok) {
        setError(securityActionErrorText(t, outcome.result.code));
        return;
      }
      draft.secret.fill(0);
      setDraft(null);
      setCode('');
      // 同改密：`onDone()` 会触发 mode 刷新，反馈必须先交到面板级 state。
      publishFeedback({ section: 'totp', tone: 'ok', text: t('auth.security.totpDone') });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, code, draft, mode.kdfParams, onDone, password, publishFeedback, t, uid]);

  const cancel = useCallback(() => {
    draft?.secret.fill(0);
    setDraft(null);
    setCode('');
    setError(null);
  }, [draft]);

  /** `clear-totp` 允许 passkey 签（不需要 seed），走统一的凭据对话框。 */
  const disable = useCallback(async () => {
    setError(null);
    publishFeedback(null);
    setBusy(true);
    try {
      const result = await prompt.withSigner((signer) => clearTotp({ api, uid, signer }), {
        purpose: 'totp',
      });
      if (!result) return;
      if (!result.ok) {
        setError(securityActionErrorText(t, result.code));
        return;
      }
      cancel();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, cancel, onDone, prompt, publishFeedback, t, uid]);

  return (
    <Section
      title={t('auth.security.totp')}
      description={
        passkeys.length > 0 ? t('auth.security.totpPasskeyNote') : t('auth.security.totpNote')
      }
    >
      {error ? <Feedback tone="error" text={error} /> : null}
      {ownFeedback ? <Feedback tone={ownFeedback.tone} text={ownFeedback.text} /> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={begin} data-testid="security-totp-set">
          {mode.totpEnabled ? t('auth.security.totpReset') : t('auth.security.totpSet')}
        </Button>
        {mode.totpEnabled ? (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void disable()}
            data-testid="security-totp-clear"
          >
            {t('auth.security.totpClear')}
          </Button>
        ) : null}
      </div>
      {draft ? (
        <div className="flex flex-col items-start gap-2" data-testid="security-totp-uri">
          <p className="text-xs text-muted-foreground">{t('auth.security.totpScanNow')}</p>
          <div className="rounded-lg bg-white p-2">
            <QRCodeSVG value={draft.otpauthUri} size={160} />
          </div>
          <code className="w-full break-all rounded-lg bg-muted p-2 text-[11px]">
            {draft.otpauthUri}
          </code>
          <p className="text-xs text-muted-foreground">{t('auth.security.totpConfirmHint')}</p>
          {/* set-totp 要用 seed 派生 k_totp，passkey 断言给不出 seed：这一步只能要密码。 */}
          <Input
            type="password"
            autoComplete="current-password"
            placeholder={t('auth.security.currentPassword')}
            value={password}
            data-testid="security-totp-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          <OtpInput
            value={code}
            onChange={setCode}
            digitLabel={(index, length) => t('auth.totpDigit', { index: index + 1, total: length })}
            data-testid="security-totp-code"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="security-totp-confirm"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t('auth.security.totpConfirm')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={cancel}
              data-testid="security-totp-cancel"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
