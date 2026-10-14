// 创建访问令牌：填名称 / 权限 / 有效期；成功后同一个对话框原地换成「只显示一次」的密钥。

import { CopyButton } from '@/pages/settings/nodes/copy-feedback';
import {
  ACCESS_TOKEN_SCOPES,
  type CreateAccessTokenRequest,
  type CreateAccessTokenResponse,
} from '@vibeterm/shared';
import { Button } from '@vibeterm/ui/button';
import { Checkbox } from '@vibeterm/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Input } from '@vibeterm/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@vibeterm/ui/select';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TOKENS_NS,
  TOKEN_EXPIRY_OPTIONS,
  TOKEN_NAME_MAX,
  TOKEN_SCOPE_COMMANDS,
  type TokenDraft,
  type TokenDraftErrors,
  type TokenExpiryOption,
  emptyTokenDraft,
  expiryOptionText,
  parseTokenDraft,
  scopeText,
  toggleScope,
  tokenErrorText,
} from './access-token-format';
import { Feedback } from './section';

export interface AccessTokenCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (body: CreateAccessTokenRequest) => Promise<CreateAccessTokenResponse>;
}

function useCreateTokenState(open: boolean, onCreate: AccessTokenCreateDialogProps['onCreate']) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TokenDraft>(emptyTokenDraft);
  const [errors, setErrors] = useState<TokenDraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  // 开关都当场重置：关掉的对话框只是隐藏，密钥不该继续留在 state 里。
  const [lastOpen, setLastOpen] = useState(open);
  if (lastOpen !== open) {
    setLastOpen(open);
    setDraft(emptyTokenDraft());
    setErrors({});
    setSubmitError(null);
    setSecret(null);
  }

  const submit = async () => {
    const parsed = parseTokenDraft(t, draft);
    setErrors(parsed.ok ? {} : parsed.errors);
    if (!parsed.ok) return;
    setSubmitError(null);
    setBusy(true);
    try {
      const res = await onCreate(parsed.body);
      setSecret(res.secret);
    } catch (err) {
      setSubmitError(tokenErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const changeDraft = (next: TokenDraft) => {
    setDraft(next);
    setSubmitError(null);
  };

  return { draft, errors, submitError, busy, secret, submit, changeDraft };
}

export function AccessTokenCreateDialog({
  open,
  onOpenChange,
  onCreate,
}: AccessTokenCreateDialogProps) {
  const { t } = useTranslation();
  const { draft, errors, submitError, busy, secret, submit, changeDraft } = useCreateTokenState(
    open,
    onCreate
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="security-token-dialog"
      >
        {secret ? (
          <CreatedSecretView secret={secret} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t(`${TOKENS_NS}.form.title`)}</DialogTitle>
            </DialogHeader>
            <AccessTokenForm
              draft={draft}
              errors={errors}
              busy={busy}
              onChange={changeDraft}
              onSubmit={() => void submit()}
            />
            {submitError ? <Feedback tone="error" text={submitError} /> : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void submit()}
                data-testid="security-token-submit"
              >
                {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
                {t(`${TOKENS_NS}.form.submit`)}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreatedSecretView({ secret, onDone }: { secret: string; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(`${TOKENS_NS}.created.title`)}</DialogTitle>
        <DialogDescription>{t(`${TOKENS_NS}.created.note`)}</DialogDescription>
      </DialogHeader>
      <AccessTokenSecret secret={secret} />
      <DialogFooter>
        <Button onClick={onDone} data-testid="security-token-done">
          {t(`${TOKENS_NS}.created.done`)}
        </Button>
      </DialogFooter>
    </>
  );
}

interface TokenFieldProps {
  draft: TokenDraft;
  errors: TokenDraftErrors;
  busy: boolean;
  onChange: (next: TokenDraft) => void;
}

/** 表单本体（无请求）：Dialog 走 portal，单测静态渲染这一块。 */
export function AccessTokenForm({
  draft,
  errors,
  busy,
  onChange,
  onSubmit,
}: TokenFieldProps & { onSubmit: () => void }) {
  const { t } = useTranslation();
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="security-token-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="security-token-name">
          {t(`${TOKENS_NS}.form.name`)}
        </label>
        <Input
          id="security-token-name"
          value={draft.name}
          maxLength={TOKEN_NAME_MAX}
          disabled={busy}
          autoComplete="off"
          placeholder={t(`${TOKENS_NS}.form.namePlaceholder`)}
          aria-invalid={errors.name ? true : undefined}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          data-testid="security-token-name"
        />
        {errors.name ? <Feedback tone="error" text={errors.name} /> : null}
      </div>

      <TokenScopeFieldset draft={draft} errors={errors} busy={busy} onChange={onChange} />
      <TokenExpirySelect draft={draft} busy={busy} onChange={onChange} />
    </form>
  );
}

function TokenScopeFieldset({ draft, errors, busy, onChange }: TokenFieldProps) {
  const { t } = useTranslation();
  return (
    <fieldset className="flex flex-col gap-2" data-testid="security-token-scopes">
      <legend className="mb-1.5 text-sm font-medium">{t(`${TOKENS_NS}.form.scopes`)}</legend>
      {ACCESS_TOKEN_SCOPES.map((scope) => {
        const id = `security-token-scope-${scope}`;
        return (
          <label key={scope} className="flex items-center gap-2 text-sm" htmlFor={id}>
            <Checkbox
              id={id}
              checked={draft.scopes.includes(scope)}
              disabled={busy}
              onCheckedChange={(checked) =>
                onChange({ ...draft, scopes: toggleScope(draft.scopes, scope, checked === true) })
              }
              data-testid={id}
            />
            <span>{scopeText(t, scope)}</span>
            <code className="text-xs text-muted-foreground">{TOKEN_SCOPE_COMMANDS[scope]}</code>
          </label>
        );
      })}
      {errors.scopes ? <Feedback tone="error" text={errors.scopes} /> : null}
    </fieldset>
  );
}

function TokenExpirySelect({ draft, busy, onChange }: Omit<TokenFieldProps, 'errors'>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{t(`${TOKENS_NS}.form.expiry`)}</span>
      <Select
        value={draft.expiry}
        onValueChange={(next) => next && onChange({ ...draft, expiry: next as TokenExpiryOption })}
      >
        <SelectTrigger
          className="w-40"
          disabled={busy}
          aria-label={t(`${TOKENS_NS}.form.expiry`)}
          data-testid="security-token-expiry"
        >
          <SelectValue>{expiryOptionText(t, draft.expiry)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TOKEN_EXPIRY_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {expiryOptionText(t, option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AccessTokenSecret({ secret }: { secret: string }) {
  return (
    <div className="flex items-center gap-1">
      <Input
        readOnly
        value={secret}
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
        data-testid="security-token-secret"
      />
      <CopyButton value={secret} testId="security-token-secret" variant="outline" />
    </div>
  );
}
