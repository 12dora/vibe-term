// 账号安全面板的「访问令牌」：给 `vibeterm exec / rsh / cp / forward` 等非交互调用用的机器凭据。
// 令牌按节点存储；面板只管本机（entry），与同面板其他区块一致。

import type { AccessTokenDto } from '@vibeterm/shared';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { ConfirmDialog } from '@vibeterm/ui/confirm-dialog';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessTokenCreateDialog } from './access-token-create-dialog';
import {
  TOKENS_NS,
  createdText,
  expiresText,
  isTokenExpired,
  lastUsedText,
  lastUsedTitle,
  scopeText,
} from './access-token-format';
import { Feedback, Section } from './section';
import { type AccessTokensState, useAccessTokens } from './use-access-tokens';

export function AccessTokenSection() {
  const state = useAccessTokens();
  return <AccessTokenSectionView state={state} />;
}

/** 视图本体（数据由调用方给）：单测直接静态渲染。 */
export function AccessTokenSectionView({
  state,
  now = Date.now(),
}: {
  state: AccessTokensState;
  now?: number;
}) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<AccessTokenDto | null>(null);
  const { tokens, loadError, revokeError } = state;

  return (
    <Section title={t(`${TOKENS_NS}.title`)} description={t(`${TOKENS_NS}.description`)}>
      <div className="flex flex-col gap-3" data-testid="security-tokens">
        {loadError ? (
          <Feedback tone="error" text={t(`${TOKENS_NS}.loadFailed`, { error: loadError })} />
        ) : null}

        <AccessTokenListBody
          state={state}
          now={now}
          onRevoke={(token) => setPendingRevoke(token)}
        />

        {revokeError ? <Feedback tone="error" text={revokeError} /> : null}

        <div>
          <Button
            type="button"
            disabled={tokens === null}
            onClick={() => setCreateOpen(true)}
            data-testid="security-token-create"
          >
            <Plus />
            {t(`${TOKENS_NS}.create`)}
          </Button>
        </div>
      </div>

      <AccessTokenCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={state.create}
      />

      <RevokeConfirm
        target={pendingRevoke}
        onClose={() => setPendingRevoke(null)}
        onRevoke={(id) => void state.revoke(id)}
      />
    </Section>
  );
}

function AccessTokenListBody({
  state,
  now,
  onRevoke,
}: {
  state: AccessTokensState;
  now: number;
  onRevoke: (token: AccessTokenDto) => void;
}) {
  const { t } = useTranslation();
  const { tokens, loadError, revokingId } = state;
  return (
    <>
      {tokens === null ? (
        loadError ? null : (
          <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        )
      ) : tokens.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="security-tokens-empty">
          {t(`${TOKENS_NS}.empty`)}
        </p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="security-token-list">
          {tokens.map((token) => (
            <AccessTokenRow
              key={token.id}
              token={token}
              now={now}
              busy={revokingId === token.id}
              disabled={revokingId !== null}
              onRevoke={() => onRevoke(token)}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function RevokeConfirm({
  target,
  onClose,
  onRevoke,
}: {
  target: AccessTokenDto | null;
  onClose: () => void;
  onRevoke: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(`${TOKENS_NS}.revokeTitle`)}
      cancelLabel={t('common.cancel')}
      confirmLabel={t(`${TOKENS_NS}.revoke`)}
      testId="security-token-revoke-dialog"
      confirmTestId="security-token-revoke-confirm"
      onConfirm={() => {
        const pending = target;
        onClose();
        if (pending) onRevoke(pending.id);
      }}
    >
      {t(`${TOKENS_NS}.revokeBody`, { name: target?.name ?? '' })}
    </ConfirmDialog>
  );
}

function AccessTokenRow({
  token,
  now,
  busy,
  disabled,
  onRevoke,
}: {
  token: AccessTokenDto;
  now: number;
  busy: boolean;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const expired = isTokenExpired(token, now);
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-2 py-1.5 text-xs"
      data-testid={`security-token-row-${token.id}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate font-medium" title={token.name}>
            {token.name}
          </span>
          {token.scopes.map((scope) => (
            <Badge key={scope} variant="secondary" data-testid={`security-token-tag-${scope}`}>
              {scopeText(t, scope)}
            </Badge>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          <span title={new Date(token.createdAt).toLocaleString()}>{createdText(t, token)}</span>
          <span aria-hidden className="text-muted-foreground/60">
            ·
          </span>
          <span title={lastUsedTitle(token) || undefined} data-testid="security-token-last-used">
            {lastUsedText(t, token, now)}
            {token.lastUsedIp ? (
              <span className="ml-1 text-muted-foreground/70">{token.lastUsedIp}</span>
            ) : null}
          </span>
          <span aria-hidden className="text-muted-foreground/60">
            ·
          </span>
          <span className={expired ? 'text-destructive' : undefined}>
            {expiresText(t, token, now)}
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant="destructive"
        size="xs"
        disabled={disabled}
        onClick={onRevoke}
        data-testid={`security-token-revoke-${token.id}`}
      >
        {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Trash2 />}
        {t(`${TOKENS_NS}.revoke`)}
      </Button>
    </li>
  );
}
