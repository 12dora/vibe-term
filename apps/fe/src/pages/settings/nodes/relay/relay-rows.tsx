// 中继链路：一条一行。以前是一排 chip + 一串 `｜` 拼接的悬浮详情，手机上既点不出也读不到；
// 现在在线态、延迟、当前挂载都在行内，被踢与最近错误直接以红字跟在下面。

import type { RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { cn } from '@tmex/ui';
import { Badge } from '@tmex/ui/badge';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 行首正文：主机名（带端口）；地址畸形时退回原串。 */
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

export function RelayRows({ relays }: { relays: RelayLinkStatus[] }) {
  const { t } = useTranslation();
  if (relays.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="nodes-relay-empty">
        {t('relay.tenant.strip.empty')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" data-testid="nodes-relay-rows">
      {relays.map((relay) => (
        <RelayRow key={relay.url} relay={relay} />
      ))}
    </div>
  );
}

function RelayRow({ relay }: { relay: RelayLinkStatus }) {
  const { t } = useTranslation();
  const host = relayLabel(relay.url);
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg px-2 py-1.5 ring-1',
        relay.attached ? 'bg-primary/5 ring-primary/40' : 'ring-border/60'
      )}
      data-testid={`nodes-relay-row-${host}`}
      data-relay-attached={relay.attached ? 'true' : 'false'}
      data-relay-online={relay.online ? 'true' : 'false'}
      data-relay-failing={relayFailing(relay) ? 'true' : 'false'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-xs font-medium">{host}</span>
        <Badge variant="outline" data-testid={`nodes-relay-online-${host}`}>
          {t(relay.online ? 'relay.tenant.strip.online' : 'relay.tenant.strip.offline')}
        </Badge>
        {typeof relay.rttMs === 'number' && (
          <span
            className="text-[11px] text-muted-foreground"
            data-testid={`nodes-relay-rtt-${host}`}
          >
            {t('relay.tenant.strip.rtt', { ms: relay.rttMs })}
          </span>
        )}
        {relay.attached && (
          <span
            className="flex items-center gap-1 text-[11px] text-primary"
            data-testid={`nodes-relay-attached-${host}`}
          >
            <Link2 className="size-3 shrink-0" aria-hidden />
            {t('relay.tenant.strip.attached')}
          </span>
        )}
      </div>
      {relay.kicked && (
        <span className="text-[11px] text-destructive" data-testid={`nodes-relay-kicked-${host}`}>
          {t('relay.tenant.strip.kicked')}
        </span>
      )}
      {relay.lastError && (
        <span
          className="break-all text-[11px] text-destructive"
          data-testid={`nodes-relay-error-${host}`}
        >
          {t('relay.tenant.strip.lastError', { error: relay.lastError })}
        </span>
      )}
    </div>
  );
}
