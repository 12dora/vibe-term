// 中继链路条：一条中继一枚 chip，正文只写主机名，在线态、挂载关系与最近错误分别落在
// 状态点、图标与悬浮详情里——与 `HubStrip` 同一套版式，中继模式下顶替它出现。

import type { RelayLinkStatus, RelayQuotaView } from '@tmex/api-client/relay/tenant-api';
import { cn } from '@tmex/ui';
import { Link2, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** chip 正文：主机名（带端口）；地址畸形时退回原串。 */
export function relayLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 这条中继当前是否需要提醒（令牌被作废 / 最近连不上）。 */
export function relayFailing(relay: RelayLinkStatus): boolean {
  return relay.kicked === true || Boolean(relay.lastError);
}

/** 悬浮详情：地址那一行 + 延迟，被踢或最近失败时再各补一行。 */
export function relayChipTitle(t: Translate, relay: RelayLinkStatus): string {
  const lines = [
    t('relay.tenant.strip.detail', {
      url: relay.url,
      priority: relay.priority,
      state: t(relay.online ? 'relay.tenant.strip.online' : 'relay.tenant.strip.offline'),
    }),
  ];
  if (relay.attached) lines.push(t('relay.tenant.strip.attached'));
  if (typeof relay.rttMs === 'number') lines.push(t('relay.tenant.strip.rtt', { ms: relay.rttMs }));
  if (relay.kicked) lines.push(t('relay.tenant.strip.kicked'));
  if (relay.lastError) lines.push(t('relay.tenant.strip.lastError', { error: relay.lastError }));
  return lines.join('\n');
}

export function RelayStrip({
  relays,
  metaEpoch,
  nodesViaRelay,
  quota,
}: {
  relays: RelayLinkStatus[];
  metaEpoch: number;
  nodesViaRelay: number;
  /** 中继下发的配额；旧中继或未接入时为 `null`，这一格就不出现。 */
  quota?: RelayQuotaView | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="nodes-relay-strip">
      <span className="text-[11px] text-muted-foreground">{t('relay.tenant.strip.title')}</span>
      {relays.length === 0 ? (
        <span className="text-[11px] text-muted-foreground" data-testid="nodes-relay-empty">
          {t('relay.tenant.strip.empty')}
        </span>
      ) : (
        relays.map((relay) => <RelayChip key={relay.url} relay={relay} />)
      )}
      <span className="text-[11px] text-muted-foreground" data-testid="nodes-relay-meta">
        {t('relay.tenant.strip.meta', { epoch: metaEpoch })}
      </span>
      <span className="text-[11px] text-muted-foreground" data-testid="nodes-relay-peers">
        {t('relay.tenant.strip.nodes', { count: nodesViaRelay })}
      </span>
      {quota && (
        <span className="text-[11px] text-muted-foreground" data-testid="nodes-relay-quota">
          {t('relay.tenant.strip.quota', {
            nodes: quota.maxNodes,
            streams: quota.maxStreams,
          })}
        </span>
      )}
    </div>
  );
}

function RelayChip({ relay }: { relay: RelayLinkStatus }) {
  const { t } = useTranslation();
  const failing = relayFailing(relay);
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]',
        relay.attached ? 'border-primary/50 bg-primary/5' : 'border-border/60'
      )}
      title={relayChipTitle(t, relay)}
      data-testid={`nodes-relay-chip-${relayLabel(relay.url)}`}
      data-relay-attached={relay.attached ? 'true' : 'false'}
      data-relay-online={relay.online ? 'true' : 'false'}
      data-relay-failing={failing ? 'true' : 'false'}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          relay.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
        )}
      />
      <span className="truncate font-medium">{relayLabel(relay.url)}</span>
      {failing && <TriangleAlert className="size-3 shrink-0 text-amber-500" aria-hidden />}
      {relay.attached && <Link2 className="size-3 shrink-0 text-primary" aria-hidden />}
    </span>
  );
}
