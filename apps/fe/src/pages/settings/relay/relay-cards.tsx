// 中继运营面的头部三卡：健康、总量、接入口令。

import { formatBytes } from '@tmex/api-client/format';
import type {
  RelayConfigSummary,
  RelayHealthResponse,
  RelayTotals,
} from '@tmex/api-client/relay/admin-api';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InfoRow, Notice } from '../components/form-primitives';
import { bandwidthText, uptimeText } from './relay-format';

function SectionCard({
  title,
  testId,
  action,
  children,
}: {
  title: string;
  testId: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" data-testid={testId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">{children}</CardContent>
    </Card>
  );
}

export function RelayHealthCard({ health }: { health: RelayHealthResponse | null }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('relay.admin.health.title')} testId="relay-health-card">
      <InfoRow label={t('relay.admin.health.state')} testId="relay-health-state">
        {health === null ? (
          t('relay.admin.health.unknown')
        ) : (
          <Badge variant={health.ok ? 'default' : 'destructive'}>
            {t(health.ok ? 'relay.admin.health.ok' : 'relay.admin.health.down')}
          </Badge>
        )}
      </InfoRow>
      <InfoRow label={t('relay.admin.health.version')} testId="relay-health-version">
        {health?.version ?? '—'}
      </InfoRow>
      <InfoRow label={t('relay.admin.health.uptime')} testId="relay-health-uptime">
        {health === null ? '—' : uptimeText(t, health.uptimeMs)}
      </InfoRow>
    </SectionCard>
  );
}

export function RelayTotalsCard({ totals }: { totals: RelayTotals }) {
  const { t } = useTranslation();
  return (
    <SectionCard title={t('relay.admin.totals.title')} testId="relay-totals-card">
      <InfoRow label={t('relay.admin.totals.tenants')} testId="relay-totals-tenants">
        {totals.tenants}
      </InfoRow>
      <InfoRow label={t('relay.admin.totals.nodesOnline')} testId="relay-totals-nodes">
        {totals.nodesOnline}
      </InfoRow>
      <InfoRow label={t('relay.admin.totals.streams')} testId="relay-totals-streams">
        {totals.streams}
      </InfoRow>
      <InfoRow label={t('relay.admin.totals.outbound')} testId="relay-totals-out">
        {formatBytes(totals.bytesOut)}
      </InfoRow>
      <InfoRow label={t('relay.admin.totals.inbound')} testId="relay-totals-in">
        {formatBytes(totals.bytesIn)}
      </InfoRow>
    </SectionCard>
  );
}

export function RelayPasswordCard({
  config,
  onChange,
}: {
  config: RelayConfigSummary;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SectionCard
      title={t('relay.admin.password.title')}
      testId="relay-password-card"
      action={
        <Button size="xs" variant="outline" onClick={onChange} data-testid="relay-password-change">
          <KeyRound />
          {t('relay.admin.password.change')}
        </Button>
      }
    >
      <InfoRow label={t('relay.admin.password.state')} testId="relay-password-state">
        <Badge variant={config.hasPassword ? 'default' : 'destructive'}>
          {t(config.hasPassword ? 'relay.admin.password.set' : 'relay.admin.password.unset')}
        </Badge>
      </InfoRow>
      <InfoRow label={t('relay.admin.password.epoch')} testId="relay-password-epoch">
        {config.passwordEpoch}
      </InfoRow>
      <InfoRow label={t('relay.admin.password.minTokenEpoch')} testId="relay-password-min-epoch">
        {config.minTokenEpoch}
      </InfoRow>
      {!config.hasPassword && (
        <Notice tone="warning" testId="relay-password-unset-warning">
          {t('relay.admin.password.unsetWarning')}
        </Notice>
      )}
    </SectionCard>
  );
}

/** 默认配额的一行摘要，摆在配额卡的标题下。 */
export function DefaultQuotaSummary({ config }: { config: RelayConfigSummary }) {
  const { t } = useTranslation();
  const quota = config.defaultQuota;
  return (
    <p className="text-xs text-muted-foreground" data-testid="relay-default-quota-summary">
      {t('relay.admin.quota.summary', {
        nodes: quota.maxNodes,
        streams: quota.maxStreams,
        bandwidth: bandwidthText(t, quota.bandwidthBytesPerSec),
      })}
    </p>
  );
}
