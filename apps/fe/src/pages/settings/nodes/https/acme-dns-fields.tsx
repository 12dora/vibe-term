import type { TlsDnsProviderId } from '@tmex/api-client/local/tls-types';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { useTranslation } from 'react-i18next';
import { Field } from './parts';
import { type AcmeDraft, type AcmeDraftErrors, TLS_DNS_PROVIDERS } from './tls-form';

const PROVIDER_LABEL: Record<TlsDnsProviderId, string> = {
  cloudflare: 'nodes.https.acme.dnsProviderCloudflare',
  dnspod: 'nodes.https.acme.dnsProviderDnspod',
};

export function AcmeDnsFields({
  draft,
  errors,
  busy,
  stored,
  patch,
}: {
  draft: AcmeDraft;
  errors: AcmeDraftErrors;
  busy: boolean;
  /** 所选服务商在节点上已存过凭证：留空即沿用旧值。 */
  stored: boolean;
  patch: (next: Partial<AcmeDraft>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="https-acme-dns">
      <Field id="https-acme-dns-provider" label={t('nodes.https.acme.dnsProvider')}>
        <Select
          value={draft.dnsProvider}
          onValueChange={(next) => next && patch({ dnsProvider: next as TlsDnsProviderId })}
        >
          <SelectTrigger
            size="sm"
            className="w-48"
            disabled={busy}
            data-testid="https-acme-dns-provider"
          >
            <SelectValue>{t(PROVIDER_LABEL[draft.dnsProvider])}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TLS_DNS_PROVIDERS.map((provider) => (
              <SelectItem
                key={provider}
                value={provider}
                data-testid={`https-acme-dns-provider-${provider}`}
              >
                {t(PROVIDER_LABEL[provider])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {draft.dnsProvider === 'cloudflare' ? (
        <Field
          id="https-acme-token"
          label={t('nodes.https.acme.dnsToken')}
          hint={
            stored
              ? t('nodes.https.acme.credentialsStored')
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
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="https-acme-dnspod-id"
            label={t('nodes.https.acme.dnspodId')}
            hint={stored ? t('nodes.https.acme.credentialsStored') : undefined}
            {...(errors.tokenId ? { error: t(errors.tokenId) } : {})}
          >
            <Input
              id="https-acme-dnspod-id"
              data-testid="https-acme-dnspod-id"
              autoComplete="off"
              value={draft.dnspodId}
              disabled={busy}
              onChange={(event) => patch({ dnspodId: event.target.value })}
            />
          </Field>
          <Field
            id="https-acme-dnspod-token"
            label={t('nodes.https.acme.dnspodToken')}
            hint={t('nodes.https.acme.dnspodHint')}
            {...(errors.token ? { error: t(errors.token) } : {})}
          >
            <Input
              id="https-acme-dnspod-token"
              data-testid="https-acme-dnspod-token"
              type="password"
              autoComplete="off"
              value={draft.dnspodToken}
              disabled={busy}
              onChange={(event) => patch({ dnspodToken: event.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
