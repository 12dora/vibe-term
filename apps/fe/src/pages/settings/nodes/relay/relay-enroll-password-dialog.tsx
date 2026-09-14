// 租户侧修改中继接入密码：须知道当前密码（本机已记录则可省略），新密码可留空以清除。

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

const ERROR_CODES = [
  'relay_password_invalid',
  'relay_password_too_short',
  'relay_members_offline',
  'relay_unreachable',
  'relay_not_attached',
] as const;

export type EnrollPasswordDraft = {
  current: string;
  next: string;
  kick: boolean;
};

export function emptyEnrollPasswordDraft(): EnrollPasswordDraft {
  return { current: '', next: '', kick: false };
}

export function enrollPasswordErrorKey(error: unknown): string {
  const raw = error instanceof RelayApiError ? error.code : relayErrorCode(error);
  const code = (raw ?? 'relay_unreachable').toLowerCase();
  const matched = ERROR_CODES.find((item) => item === code);
  return `relay.tenant.enrollPassword.errors.${matched ?? 'relay_unreachable'}`;
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
  const next = draft.next.length === 0 ? null : draft.next;
  if (next !== null && next.length < ENROLL_PASSWORD_MIN_LENGTH) {
    return { ok: false, errorKey: 'relay.tenant.enrollPassword.errors.relay_password_too_short' };
  }
  return {
    ok: true,
    ...(known ? {} : { current: draft.current }),
    next,
    mode: draft.kick ? 'kick' : 'keep',
  };
}

export async function rotateEnrollPasswordDraft(
  url: string,
  draft: EnrollPasswordDraft,
  known: boolean,
  api: RelayTenantApi = defaultRelayTenantApi
): Promise<{ ok: true; cleared: boolean } | { ok: false; errorKey: string }> {
  const parsed = parseEnrollPasswordDraft(draft, known);
  if (!parsed.ok) return parsed;
  try {
    await api.rotateEnrollPassword({
      url,
      next: parsed.next,
      mode: parsed.mode,
      ...(parsed.current === undefined ? {} : { current: parsed.current }),
    });
    return { ok: true, cleared: parsed.next === null };
  } catch (error) {
    return { ok: false, errorKey: enrollPasswordErrorKey(error) };
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

export function RelayEnrollPasswordDialogBody({
  draft,
  known,
  errorKey,
  busy,
  onChange,
}: {
  draft: EnrollPasswordDraft;
  known: boolean;
  errorKey: string | null;
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
          disabled={busy}
          onChange={(next) => onChange({ next })}
        />
      </FormField>
      <label
        className="flex cursor-pointer items-start gap-2 text-xs"
        htmlFor="nodes-relay-enroll-password-kick"
      >
        <input
          id="nodes-relay-enroll-password-kick"
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={draft.kick}
          disabled={busy}
          onChange={(event) => onChange({ kick: event.target.checked })}
          data-testid="nodes-relay-enroll-password-kick"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{t('relay.tenant.enrollPassword.kick')}</span>
          <span className="text-muted-foreground">{t('relay.tenant.enrollPassword.kickHint')}</span>
        </span>
      </label>
      {errorKey && (
        <Notice tone="error" testId="nodes-relay-enroll-password-error">
          {t(errorKey)}
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
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    setDraft(emptyEnrollPasswordDraft());
    setErrorKey(null);
    setBusy(false);
  }

  const submit = () => {
    if (busy) return;
    setBusy(true);
    void rotateEnrollPasswordDraft(url, draft, known, api).then((result) => {
      setBusy(false);
      if (!result.ok) {
        setErrorKey(result.errorKey);
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
          errorKey={errorKey}
          busy={busy}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />
        <EnrollPasswordFooter busy={busy} onCancel={() => onOpenChange(false)} onSubmit={submit} />
      </DialogContent>
    </Dialog>
  );
}
