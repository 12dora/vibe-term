import type { AuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Checkbox } from '@tmex/ui/checkbox';
import { Input } from '@tmex/ui/input';
import { OtpInput } from '@tmex/ui/otp-input';
import { AlertTriangle, KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { submitPasswordChange } from '../account-security-password';
import { Feedback, Section } from './section';
import type { ResolvedMode, SecurityActionFeedback } from './types';

function PasswordFields({
  oldPassword,
  newPassword,
  confirm,
  onOldPassword,
  onNewPassword,
  onConfirm,
}: {
  oldPassword: string;
  newPassword: string;
  confirm: string;
  onOldPassword: (value: string) => void;
  onNewPassword: (value: string) => void;
  onConfirm: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Input
        type="password"
        autoComplete="current-password"
        placeholder={t('auth.security.currentPassword')}
        value={oldPassword}
        data-testid="security-old-password"
        onChange={(event) => onOldPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.newPassword')}
        value={newPassword}
        data-testid="security-new-password"
        onChange={(event) => onNewPassword(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="new-password"
        placeholder={t('auth.security.confirmPassword')}
        value={confirm}
        data-testid="security-confirm-password"
        onChange={(event) => onConfirm(event.target.value)}
      />
    </>
  );
}

/** 常规改密后要重新登录一次 entry；开了 TOTP 就得当场给一个码，留空则跳过。 */
function ReloginCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">{t('auth.security.reloginTotpHint')}</p>
      <OtpInput
        value={value}
        onChange={onChange}
        digitLabel={(index, length) => t('auth.totpDigit', { index: index + 1, total: length })}
        data-testid="security-relogin-code"
      />
    </div>
  );
}

/** 全量重置的开关与它的破坏性警告：勾上之前不摆警告，免得常规改密被误读成会清空一切。 */
function FullResetOption({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label className="flex items-start gap-2 text-xs" htmlFor="security-full-reset">
        <Checkbox
          id="security-full-reset"
          checked={checked}
          onCheckedChange={(next) => onChange(next === true)}
          data-testid="security-full-reset"
        />
        <span className="flex flex-col gap-0.5">
          {t('auth.security.fullReset')}
          <span className="text-muted-foreground">{t('auth.security.fullResetHint')}</span>
        </span>
      </label>
      {checked ? (
        <p
          className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="password-warning"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('auth.security.changePasswordWarning')}</span>
        </p>
      ) : null}
    </>
  );
}

/** 单独导出供测试静态渲染：`initialFullReset` 只用来摆出勾选后的形态。 */
export function PasswordSection({
  mode,
  api,
  uid,
  onDone,
  feedback,
  publishFeedback,
  initialFullReset = false,
}: {
  mode: ResolvedMode;
  api: AuthApi;
  uid: string;
  onDone: () => void;
  feedback: SecurityActionFeedback | null;
  publishFeedback: (next: SecurityActionFeedback | null) => void;
  initialFullReset?: boolean;
}) {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fullReset, setFullReset] = useState(initialFullReset);
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownFeedback = feedback?.section === 'password' ? feedback : null;
  const totpEnabled = Boolean(mode.totpEnabled);

  const submit = useCallback(async () => {
    setError(null);
    publishFeedback(null);
    if (!oldPassword || !newPassword) {
      setError(t('auth.security.passwordRequired'));
      return;
    }
    if (newPassword !== confirm) {
      setError(t('auth.security.passwordMismatch'));
      return;
    }
    setBusy(true);
    try {
      const outcome = await submitPasswordChange({
        api,
        uid,
        nodeId: mode.nodeId,
        kdfParams: mode.kdfParams,
        oldPassword,
        newPassword,
        fullReset,
        totpEnabled,
        totpCode,
        t,
      });
      if (outcome.tone === 'error') {
        setError(outcome.text);
        return;
      }
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setTotpCode('');
      // 先发反馈再 `onDone()`：后者会触发一次 mode 刷新，本地 state 存不住这行字。
      publishFeedback({ ...outcome, section: 'password' });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    api,
    confirm,
    fullReset,
    mode.kdfParams,
    mode.nodeId,
    newPassword,
    oldPassword,
    onDone,
    publishFeedback,
    t,
    totpCode,
    totpEnabled,
    uid,
  ]);

  return (
    <Section title={t('auth.security.changePassword')}>
      <PasswordFields
        oldPassword={oldPassword}
        newPassword={newPassword}
        confirm={confirm}
        onOldPassword={setOldPassword}
        onNewPassword={setNewPassword}
        onConfirm={setConfirm}
      />
      {totpEnabled && !fullReset ? (
        <ReloginCodeField value={totpCode} onChange={setTotpCode} />
      ) : null}
      <FullResetOption checked={fullReset} onChange={setFullReset} />
      {error ? <Feedback tone="error" text={error} /> : null}
      {ownFeedback ? <Feedback tone={ownFeedback.tone} text={ownFeedback.text} /> : null}
      <div>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          data-testid="security-change-password"
        >
          {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {t('auth.security.changePassword')}
        </Button>
      </div>
    </Section>
  );
}
