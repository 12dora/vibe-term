// 改接入口令：设新口令或清除口令，并二选一决定现有租户是踢是留。
//
// 默认「保留」——改口令多数时候只是换一把新的，不该顺手把在线租户全踢下线。

import { PasswordFieldWithGenerate } from '@/components/forms/password-field-with-generate';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Switch } from '@tmex/ui/switch';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField, Notice } from '../components/form-primitives';
import { type PasswordDraft, emptyPasswordDraft, parsePasswordDraft } from './relay-forms';

export interface PasswordDialogProps {
  open: boolean;
  busy: boolean;
  /** 提交失败的原因；成功由调用方关框。 */
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: PasswordDraft) => void;
}

/** 对话框正文。单独导出：Dialog 走 portal，静态渲染只看得到这一块。 */
export function PasswordDialogBody({
  draft,
  invalid,
  error,
  busy,
  onChange,
}: {
  draft: PasswordDraft;
  invalid: string | null;
  error: string | null;
  busy: boolean;
  onChange: (patch: Partial<PasswordDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4" data-testid="relay-password-body">
      <label
        className="flex items-center justify-between gap-3 text-sm"
        htmlFor="relay-password-clear"
      >
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{t('relay.admin.password.clear')}</span>
          <span className="text-xs text-muted-foreground">
            {t('relay.admin.password.clearHint')}
          </span>
        </span>
        <Switch
          id="relay-password-clear"
          checked={draft.clear}
          disabled={busy}
          aria-label={t('relay.admin.password.clear')}
          onCheckedChange={(next) => onChange({ clear: next === true })}
          data-testid="relay-password-clear"
        />
      </label>

      {!draft.clear && (
        <FormField
          id="relay-password-new"
          label={t('relay.admin.password.newPassword')}
          hint={t('relay.admin.password.newPasswordHint')}
          error={invalid ? t(invalid) : undefined}
          spacing="tight"
        >
          <PasswordFieldWithGenerate
            id="relay-password-new"
            value={draft.password}
            disabled={busy}
            defaultGenerate
            onChange={(next) => onChange({ password: next })}
          />
        </FormField>
      )}

      <fieldset className="flex flex-col gap-2" data-testid="relay-password-mode">
        <legend className="mb-1 text-sm font-medium">{t('relay.admin.password.modeLabel')}</legend>
        <ModeOption
          value="keep"
          selected={draft.mode === 'keep'}
          disabled={busy}
          onSelect={() => onChange({ mode: 'keep' })}
        />
        <ModeOption
          value="kick"
          selected={draft.mode === 'kick'}
          disabled={busy}
          onSelect={() => onChange({ mode: 'kick' })}
        />
      </fieldset>

      {error && (
        <Notice tone="error" testId="relay-password-error">
          {error}
        </Notice>
      )}
    </div>
  );
}

function ModeOption({
  value,
  selected,
  disabled,
  onSelect,
}: {
  value: 'keep' | 'kick';
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const suffix = value === 'keep' ? 'Keep' : 'Kick';
  return (
    <label
      className="flex cursor-pointer items-start gap-2 rounded-lg border border-border/60 p-2 text-sm has-checked:border-primary/60 has-checked:bg-primary/5"
      htmlFor={`relay-password-mode-${value}`}
    >
      <input
        id={`relay-password-mode-${value}`}
        type="radio"
        name="relay-password-mode"
        className="mt-1 accent-primary"
        value={value}
        checked={selected}
        disabled={disabled}
        onChange={onSelect}
        data-testid={`relay-password-mode-${value}`}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{t(`relay.admin.password.mode${suffix}`)}</span>
        <span className="text-xs text-muted-foreground">
          {t(`relay.admin.password.mode${suffix}Hint`)}
        </span>
      </span>
    </label>
  );
}

export function PasswordDialog({ open, busy, error, onOpenChange, onSubmit }: PasswordDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PasswordDraft>(emptyPasswordDraft);
  const [invalid, setInvalid] = useState<string | null>(null);

  // 每次打开都从空草稿开始：口令框里绝不能留上一次输入的残值。
  useEffect(() => {
    if (open) {
      setDraft(emptyPasswordDraft());
      setInvalid(null);
    }
  }, [open]);

  const submit = () => {
    const parsed = parsePasswordDraft(draft);
    if (parsed.body === null) {
      setInvalid(parsed.error);
      return;
    }
    setInvalid(null);
    onSubmit(draft);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="relay-password-dialog">
        <DialogHeader>
          <DialogTitle>{t('relay.admin.password.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('relay.admin.password.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <PasswordDialogBody
          draft={draft}
          invalid={invalid}
          error={error}
          busy={busy}
          onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        />

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={submit}
            data-testid="relay-password-submit"
          >
            {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
