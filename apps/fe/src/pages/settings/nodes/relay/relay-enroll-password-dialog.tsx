// 租户侧修改中继接入密码：须知道当前密码（本机已记录则可省略）；空的新密码只有勾选清除后才提交。

import { PasswordFieldWithGenerate } from '@/components/forms/password-field-with-generate';
import { RelayApiError } from '@vibeterm/api-client/relay/admin-api';
import {
  type RelayPasswordRotateMode,
  type RelayTenantApi,
  defaultRelayTenantApi,
  relayErrorCode,
} from '@vibeterm/api-client/relay/tenant-api';
import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormField, Notice } from '../../components/form-primitives';

export const ENROLL_PASSWORD_MIN_LENGTH = 8;

const ERROR_KEY_PREFIX = 'relay.tenant.enrollPassword.errors.';

const ERROR_CODE_KEYS: Record<string, string> = {
  relay_password_invalid: 'relay_password_invalid',
  relay_password_too_short: 'relay_password_too_short',
  relay_members_offline: 'relay_members_offline',
  relay_unreachable: 'relay_unreachable',
  relay_not_attached: 'relay_not_attached',
  relay_rate_limited: 'relay_rate_limited',
  unauthorized: 'unauthorized',
  relay_unauthorized: 'unauthorized',
  malformed: 'malformed',
  invalid_url: 'malformed',
};

export type EnrollPasswordError = {
  key: string;
  params?: Record<string, string>;
};

export type EnrollPasswordDraft = {
  current: string;
  next: string;
  kick: boolean;
  clear: boolean;
};

export function emptyEnrollPasswordDraft(): EnrollPasswordDraft {
  return { current: '', next: '', kick: false, clear: false };
}

export function enrollPasswordError(error: unknown): EnrollPasswordError {
  const raw = error instanceof RelayApiError ? error.code : relayErrorCode(error);
  const code = (raw ?? '').toLowerCase();
  const mapped = ERROR_CODE_KEYS[code];
  if (mapped) return { key: `${ERROR_KEY_PREFIX}${mapped}` };
  const status = error instanceof RelayApiError ? error.status : 0;
  if (status >= 500 || status === 0) {
    return { key: `${ERROR_KEY_PREFIX}relay_unreachable` };
  }
  return { key: `${ERROR_KEY_PREFIX}unknown`, params: { code: raw ?? String(status) } };
}

export function enrollPasswordErrorKey(error: unknown): string {
  return enrollPasswordError(error).key;
}

export type ParsedEnrollPassword =
  | {
      ok: true;
      current?: string;
      next: string | null;
      mode: RelayPasswordRotateMode;
    }
  | { ok: false; errorKey: string };

export function parseEnrollPasswordDraft(
  draft: EnrollPasswordDraft,
  known: boolean
): ParsedEnrollPassword {
  if (!known && draft.current.length === 0) {
    return { ok: false, errorKey: `${ERROR_KEY_PREFIX}current_required` };
  }
  if (draft.next.length === 0) {
    if (!draft.clear) {
      return { ok: false, errorKey: `${ERROR_KEY_PREFIX}next_required` };
    }
    return {
      ok: true,
      ...(known ? {} : { current: draft.current }),
      next: null,
      mode: draft.kick ? 'kick' : 'keep',
    };
  }
  if (draft.next.length < ENROLL_PASSWORD_MIN_LENGTH) {
    return { ok: false, errorKey: `${ERROR_KEY_PREFIX}relay_password_too_short` };
  }
  return {
    ok: true,
    ...(known ? {} : { current: draft.current }),
    next: draft.next,
    mode: draft.kick ? 'kick' : 'keep',
  };
}

export async function rotateEnrollPasswordDraft(
  url: string,
  draft: EnrollPasswordDraft,
  known: boolean,
  api: RelayTenantApi = defaultRelayTenantApi
): Promise<{ ok: true; cleared: boolean } | ({ ok: false } & EnrollPasswordError)> {
  const parsed = parseEnrollPasswordDraft(draft, known);
  if (!parsed.ok) return { ok: false, key: parsed.errorKey };
  try {
    await api.rotateEnrollPassword({
      url,
      next: parsed.next,
      mode: parsed.mode,
      ...(parsed.current === undefined ? {} : { current: parsed.current }),
    });
    return { ok: true, cleared: parsed.next === null };
  } catch (error) {
    const mapped = enrollPasswordError(error);
    return { ok: false, key: mapped.key, ...(mapped.params ? { params: mapped.params } : {}) };
  }
}

function CurrentPasswordField({
  value,
  busy,
  onChange,
}: {
  value: string;
  busy: boolean;
  onChange: (current: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormField
      id="nodes-relay-enroll-password-current"
      label={t('relay.tenant.enrollPassword.current')}
      hint={t('relay.tenant.enrollPassword.currentHint')}
      spacing="tight"
    >
      <Input
        id="nodes-relay-enroll-password-current"
        type="password"
        autoComplete="off"
        value={value}
        disabled={busy}
        data-testid="nodes-relay-enroll-password-current"
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

function EnrollPasswordCheck({
  id,
  checked,
  disabled,
  titleKey,
  hintKey,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  titleKey: string;
  hintKey?: string;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={id}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{t(titleKey)}</span>
        {hintKey && <span className="text-muted-foreground">{t(hintKey)}</span>}
      </span>
    </label>
  );
}

export function RelayEnrollPasswordDialogBody({
  draft,
  known,
  error,
  busy,
  onChange,
}: {
  draft: EnrollPasswordDraft;
  known: boolean;
  error: EnrollPasswordError | null;
  busy: boolean;
  onChange: (patch: Partial<EnrollPasswordDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="nodes-relay-enroll-password-body">
      {!known && (
        <CurrentPasswordField
          value={draft.current}
          busy={busy}
          onChange={(current) => onChange({ current })}
        />
      )}
      <FormField
        id="nodes-relay-enroll-password-next"
        label={t('relay.tenant.enrollPassword.next')}
        hint={t('relay.tenant.enrollPassword.nextHint')}
        spacing="tight"
      >
        <PasswordFieldWithGenerate
          id="nodes-relay-enroll-password-next"
          value={draft.next}
          disabled={busy || draft.clear}
          onChange={(next) => onChange({ next })}
        />
      </FormField>
      <EnrollPasswordCheck
        id="nodes-relay-enroll-password-clear"
        checked={draft.clear}
        disabled={busy}
        titleKey="relay.tenant.enrollPassword.clear"
        onChange={(clear) => onChange(clear ? { clear, next: '' } : { clear })}
      />
      <EnrollPasswordCheck
        id="nodes-relay-enroll-password-kick"
        checked={draft.kick}
        disabled={busy}
        titleKey="relay.tenant.enrollPassword.kick"
        hintKey="relay.tenant.enrollPassword.kickHint"
        onChange={(kick) => onChange({ kick })}
      />
      {error && (
        <Notice tone="error" testId="nodes-relay-enroll-password-error">
          {t(error.key, error.params)}
        </Notice>
      )}
    </div>
  );
}

export interface RelayEnrollPasswordDialogProps {
  open: boolean;
  url: string;
  known: boolean;
  api?: RelayTenantApi;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}

function toastRotateDone(t: (key: string) => string, cleared: boolean): void {
  toast.success(
    t(cleared ? 'relay.tenant.enrollPassword.cleared' : 'relay.tenant.enrollPassword.done')
  );
}

function EnrollPasswordFooter({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={onCancel}
        data-testid="nodes-relay-enroll-password-cancel"
      >
        {t('common.cancel')}
      </Button>
      <Button
        type="button"
        disabled={busy}
        onClick={onSubmit}
        data-testid="nodes-relay-enroll-password-submit"
      >
        {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
        {t('common.save')}
      </Button>
    </DialogFooter>
  );
}

export function RelayEnrollPasswordDialog({
  open,
  url,
  known,
  api = defaultRelayTenantApi,
  onOpenChange,
  onDone,
}: RelayEnrollPasswordDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EnrollPasswordDraft>(emptyEnrollPasswordDraft);
  const [error, setError] = useState<EnrollPasswordError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (busy) return;
    setBusy(true);
    void rotateEnrollPasswordDraft(url, draft, known, api).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setError({ key: result.key, params: result.params });
        return;
      }
      setDraft(emptyEnrollPasswordDraft());
      toastRotateDone(t, result.cleared);
      onDone();
      onOpenChange(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="nodes-relay-enroll-password-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('relay.tenant.enrollPassword.title')}</DialogTitle>
          <DialogDescription>{t('relay.tenant.enrollPassword.description')}</DialogDescription>
        </DialogHeader>
        <RelayEnrollPasswordDialogBody
          draft={draft}
          known={known}
          error={error}
          busy={busy}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />
        <EnrollPasswordFooter busy={busy} onCancel={() => onOpenChange(false)} onSubmit={submit} />
      </DialogContent>
    </Dialog>
  );
}
