// 被分享页的密码表单：标题即分享名称，一行错误，限速时按秒倒数并禁用提交。

import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { AlertTriangle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShareAccessErrorCode } from './access-client';
import { shareLockSeconds } from './share-state';
import { useShareNow } from './use-share-now';

const ERROR_KEYS: Record<ShareAccessErrorCode, string> = {
  SHARE_PASSWORD_INVALID: 'shareAccess.passwordInvalid',
  SHARE_LOGIN_LOCKED: 'shareAccess.locked',
  SHARE_ENDED: 'shareAccess.ended',
  SHARE_NOT_FOUND: 'shareAccess.notFound',
  SHARE_REQUEST_FAILED: 'shareAccess.requestFailed',
};

export interface SharePasswordFormProps {
  name: string;
  error: ShareAccessErrorCode | null;
  lockedUntil: number | null;
  submitting: boolean;
  onSubmit: (password: string) => void;
}

export function SharePasswordForm({
  name,
  error,
  lockedUntil,
  submitting,
  onSubmit,
}: SharePasswordFormProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const now = useShareNow(lockedUntil !== null, 1000);
  const lockSeconds = shareLockSeconds(lockedUntil, now);
  const locked = lockSeconds > 0;

  const message = localError
    ? t(localError)
    : error
      ? t(ERROR_KEYS[error], { seconds: lockSeconds })
      : null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (submitting || locked) return;
    if (!password) {
      setLocalError('shareAccess.passwordRequired');
      return;
    }
    setLocalError(null);
    onSubmit(password);
  };

  return (
    <div className="flex min-h-full items-center justify-center p-4" data-testid="share-password">
      <form
        className="tmex-reveal flex w-full max-w-sm flex-col gap-4 rounded-xl border border-border bg-background p-6"
        onSubmit={submit}
      >
        <h1 className="truncate text-base font-semibold" data-testid="share-name">
          {name}
        </h1>

        <div className="flex flex-col gap-1 text-sm">
          <label className="text-muted-foreground" htmlFor="share-password-input">
            {t('shareAccess.password')}
          </label>
          <div className="relative">
            <Input
              id="share-password-input"
              type={revealed ? 'text' : 'password'}
              className="pr-9"
              value={password}
              autoComplete="current-password"
              autoFocus
              data-testid="share-password-input"
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={t(revealed ? 'shareAccess.hidePassword' : 'shareAccess.showPassword')}
              data-testid="share-password-reveal"
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
        </div>

        <output className="sr-only" aria-live="polite">
          {message ?? ''}
        </output>
        {message ? (
          <p
            className="tmex-fade flex items-start gap-1.5 text-sm text-destructive"
            data-testid="share-password-error"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{message}</span>
          </p>
        ) : null}

        <Button type="submit" disabled={submitting || locked} data-testid="share-password-submit">
          {submitting ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
          {t('shareAccess.continue')}
        </Button>
      </form>
    </div>
  );
}
