// Let's Encrypt 模式。签发是后台任务：保存只把状态置为 pending，成败要靠轮询看。
//
// 失败原因几乎全是「校验通道不通」，所以错误旁边一定要给出人话解释：
// http-01 需要公网 80 能打到本机明文端口，dns-01 需要一个有 Zone:DNS:Edit 的 Cloudflare token。

import type {
  TlsAcmeStatus,
  TlsChallenge,
  TlsStatusResponse,
} from '@tmex/api-client/local/tls-types';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Switch } from '@tmex/ui/switch';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Field, InfoRow, ListenerFields, Notice } from './parts';
import {
  formatTimestamp,
  validateBindHost,
  validateDomain,
  validateEmail,
  validatePort,
} from './tls-form';

interface AcmeDraft {
  domain: string;
  email: string;
  challenge: TlsChallenge;
  cloudflareToken: string;
  staging: boolean;
  tlsPort: string;
  bindHost: string;
}

interface DraftErrors {
  domain?: string;
  email?: string;
  token?: string;
  port?: string;
  host?: string;
}

const STATE_VARIANT: Record<TlsAcmeStatus['status'], 'secondary' | 'outline' | 'destructive'> = {
  idle: 'outline',
  pending: 'secondary',
  ok: 'secondary',
  error: 'destructive',
};

export function AcmePanel({
  status,
  defaultDomain,
  busy,
  savePending,
  renewPending,
  onSave,
  onRenew,
}: {
  status: TlsStatusResponse;
  /** 首次配置时的域名预填（取地址栏主机名，回环地址不预填）。 */
  defaultDomain: string;
  /** 保存 / 续签 / ACME 后台签发进行中：整个面板只读。 */
  busy: boolean;
  savePending: boolean;
  renewPending: boolean;
  onSave: (draft: {
    domain: string;
    email: string;
    challenge: TlsChallenge;
    cloudflareToken?: string;
    staging: boolean;
    tlsPort: number;
    bindHost: string;
  }) => void;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  const acme = status.acme;
  const [draft, setDraft] = useState<AcmeDraft>(() => ({
    domain: acme?.domain || defaultDomain,
    email: acme?.email ?? '',
    challenge: acme?.challenge ?? 'http-01',
    cloudflareToken: '',
    staging: acme?.staging ?? false,
    tlsPort: String(status.tlsPort),
    bindHost: status.bindHost,
  }));
  const [errors, setErrors] = useState<DraftErrors>({});

  const hasStoredToken = Boolean(acme?.hasCloudflareToken);
  const patch = (next: Partial<AcmeDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const submit = () => {
    const next: DraftErrors = {};
    const domainError = validateDomain(draft.domain);
    if (domainError) next.domain = domainError;
    const emailError = validateEmail(draft.email);
    if (emailError) next.email = emailError;
    const portError = validatePort(draft.tlsPort);
    if (portError) next.port = portError;
    const hostError = validateBindHost(draft.bindHost);
    if (hostError) next.host = hostError;
    const token = draft.cloudflareToken.trim();
    if (draft.challenge === 'dns-01' && !token && !hasStoredToken) {
      next.token = 'nodes.https.validation.tokenRequired';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    onSave({
      domain: draft.domain.trim(),
      email: draft.email.trim(),
      challenge: draft.challenge,
      ...(draft.challenge === 'dns-01' && token ? { cloudflareToken: token } : {}),
      staging: draft.staging,
      tlsPort: Number(draft.tlsPort.trim()),
      bindHost: draft.bindHost.trim(),
    });
  };

  return (
    <div className="space-y-3" data-testid="https-acme-panel">
      <p className="text-xs text-muted-foreground">{t('nodes.https.acme.intro')}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id="https-acme-domain"
          label={t('nodes.https.acme.domain')}
          hint={t('nodes.https.acme.domainHint')}
          {...(errors.domain ? { error: t(errors.domain) } : {})}
        >
          <Input
            id="https-acme-domain"
            data-testid="https-acme-domain"
            value={draft.domain}
            disabled={busy}
            onChange={(event) => patch({ domain: event.target.value })}
          />
        </Field>
        <Field
          id="https-acme-email"
          label={t('nodes.https.acme.email')}
          hint={t('nodes.https.acme.emailHint')}
          {...(errors.email ? { error: t(errors.email) } : {})}
        >
          <Input
            id="https-acme-email"
            data-testid="https-acme-email"
            type="email"
            value={draft.email}
            disabled={busy}
            onChange={(event) => patch({ email: event.target.value })}
          />
        </Field>
      </div>

      <fieldset className="space-y-1.5" disabled={busy}>
        <legend className="text-sm font-medium">{t('nodes.https.acme.challenge')}</legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
          {(['http-01', 'dns-01'] as const).map((challenge) => (
            <label
              key={challenge}
              data-testid={`https-acme-challenge-${challenge}`}
              data-selected={draft.challenge === challenge ? 'true' : 'false'}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-lg p-2 ring-1 transition-colors ${
                draft.challenge === challenge
                  ? 'bg-primary/5 ring-primary'
                  : 'bg-card ring-foreground/10 hover:bg-muted/50'
              }`}
            >
              <input
                type="radio"
                name="https-acme-challenge"
                className="sr-only"
                checked={draft.challenge === challenge}
                onChange={() => patch({ challenge })}
              />
              <span className="text-sm font-medium">
                {t(
                  challenge === 'http-01'
                    ? 'nodes.https.acme.challengeHttp'
                    : 'nodes.https.acme.challengeDns'
                )}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(
                  challenge === 'http-01'
                    ? 'nodes.https.acme.challengeHttpHint'
                    : 'nodes.https.acme.challengeDnsHint'
                )}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {draft.challenge === 'dns-01' && (
        <Field
          id="https-acme-token"
          label={t('nodes.https.acme.cloudflareToken')}
          hint={
            hasStoredToken
              ? t('nodes.https.acme.cloudflareTokenStored')
              : t('nodes.https.acme.cloudflareTokenHint')
          }
          {...(errors.token ? { error: t(errors.token) } : {})}
        >
          <Input
            id="https-acme-token"
            data-testid="https-acme-token"
            type="password"
            autoComplete="off"
            value={draft.cloudflareToken}
            disabled={busy}
            onChange={(event) => patch({ cloudflareToken: event.target.value })}
          />
        </Field>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <label className="block text-sm font-medium" htmlFor="https-acme-staging">
            {t('nodes.https.acme.staging')}
          </label>
          <p className="text-xs text-muted-foreground">{t('nodes.https.acme.stagingHint')}</p>
        </div>
        <Switch
          id="https-acme-staging"
          data-testid="https-acme-staging"
          checked={draft.staging}
          disabled={busy}
          onCheckedChange={(next) => patch({ staging: Boolean(next) })}
        />
      </div>

      <ListenerFields
        idPrefix="https-acme"
        port={draft.tlsPort}
        bindHost={draft.bindHost}
        disabled={busy}
        {...(errors.port ? { portError: t(errors.port) } : {})}
        {...(errors.host ? { hostError: t(errors.host) } : {})}
        onPortChange={(tlsPort) => patch({ tlsPort })}
        onBindHostChange={(bindHost) => patch({ bindHost })}
      />

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={submit}
          data-testid="https-acme-save"
        >
          {savePending ? <Loader2 className="animate-spin" /> : <Save />}
          {t('nodes.https.save')}
        </Button>
      </div>

      {acme && (
        <AcmeStatusBlock acme={acme} busy={busy} renewPending={renewPending} onRenew={onRenew} />
      )}
    </div>
  );
}

function AcmeStatusBlock({
  acme,
  busy,
  renewPending,
  onRenew,
}: {
  acme: TlsAcmeStatus;
  busy: boolean;
  renewPending: boolean;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg bg-muted/40 p-3" data-testid="https-acme-status">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('nodes.https.acme.statusLabel')}</span>
        <Badge variant={STATE_VARIANT[acme.status]} data-testid="https-acme-state">
          {t(`nodes.https.acme.status.${acme.status}`)}
        </Badge>
        {acme.status === 'pending' && (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-testid="https-acme-pending"
          >
            <Loader2 className="size-3.5 animate-spin" />
            {t('nodes.https.acme.pendingHint')}
          </span>
        )}
      </div>

      <InfoRow label={t('nodes.https.acme.lastAttempt')} testId="https-acme-last-attempt">
        {formatTimestamp(acme.lastAttemptAt)}
      </InfoRow>
      <InfoRow label={t('nodes.https.acme.nextRenew')} testId="https-acme-next-renew">
        {formatTimestamp(acme.nextRenewAt)}
      </InfoRow>

      {acme.status === 'error' && (
        <Notice tone="error" testId="https-acme-error">
          <p className="break-all font-mono">
            {acme.lastError ?? t('nodes.https.errors.tls_failed')}
          </p>
          <p>
            {t(
              acme.challenge === 'http-01'
                ? 'nodes.https.acme.hints.http01'
                : 'nodes.https.acme.hints.dns01'
            )}
          </p>
          {acme.challenge === 'http-01' && <p>{t('nodes.https.acme.hints.http01Linux')}</p>}
        </Notice>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onRenew}
          data-testid="https-acme-renew"
        >
          {renewPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t('nodes.https.acme.renewNow')}
        </Button>
      </div>
    </div>
  );
}
