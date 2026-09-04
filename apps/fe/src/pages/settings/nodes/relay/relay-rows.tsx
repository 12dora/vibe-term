// 中继链路：一条一行。行内只留两样东西——地址与一枚状态徽标；错误按稳定错误码查表，
// 原始错误串（`ECONNRESET` 之类）从不上屏。
//
// 多于一条时行本身是选择器：当前挂载的那条高亮，点其余任意一条即切过去。

import type { RelayLinkErrorCode, RelayLinkStatus } from '@tmex/api-client/relay/tenant-api';
import { cn } from '@tmex/ui';
import { Badge } from '@tmex/ui/badge';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** 行首正文：主机名（带端口）；地址畸形时退回原串。 */
export function relayLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const LINK_ERROR_CODES = new Set<string>([
  'connect-failed',
  'connect-timeout',
  'auth-timeout',
  'auth-rejected',
  'heartbeat-lost',
  'kicked',
  'dns',
  'refused',
  'tls',
  'protocol',
  'unknown',
] satisfies RelayLinkErrorCode[]);

/**
 * 这一行该显示的错误文案 key；在线或没有未恢复的错误时为 `null`。
 * 只有原始错误串（旧网关不下发错误码）时一律归到 `unknown`：那串东西对用户没有意义。
 */
export function relayLinkErrorKey(relay: RelayLinkStatus): string | null {
  if (relay.online) return null;
  const code = relay.lastErrorCode;
  if (code && LINK_ERROR_CODES.has(code)) return `relay.tenant.linkErrors.${code}`;
  return code || relay.lastError ? 'relay.tenant.linkErrors.unknown' : null;
}

/** 这条中继当前是否需要提醒（令牌被作废 / 掉线且有错）。 */
export function relayFailing(relay: RelayLinkStatus): boolean {
  return relay.kicked === true || relayLinkErrorKey(relay) !== null;
}

export interface RelayRowsProps {
  relays: RelayLinkStatus[];
  /** 传了且多于一条时行可选：点非当前那条即请求切过去。 */
  onSelect?: (relay: RelayLinkStatus) => void;
}

export function RelayRows({ relays, onSelect }: RelayRowsProps) {
  const { t } = useTranslation();
  if (relays.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="nodes-relay-empty">
        {t('relay.tenant.strip.empty')}
      </p>
    );
  }
  const selectable = relays.length > 1 && onSelect !== undefined;
  return (
    <div className="flex flex-col gap-1" data-testid="nodes-relay-rows">
      {relays.map((relay) => (
        <RelayRow key={relay.url} relay={relay} selectable={selectable} onSelect={onSelect} />
      ))}
    </div>
  );
}

function RelayRow({
  relay,
  selectable,
  onSelect,
}: {
  relay: RelayLinkStatus;
  selectable: boolean;
  onSelect?: (relay: RelayLinkStatus) => void;
}) {
  const { t } = useTranslation();
  const host = relayLabel(relay.url);
  const errorKey = relayLinkErrorKey(relay);
  const line = <RelayLine relay={relay} host={host} current={selectable && relay.attached} />;
  return (
    <div
      className="flex flex-col gap-0.5"
      data-testid={`nodes-relay-row-${host}`}
      data-relay-attached={relay.attached ? 'true' : 'false'}
      data-relay-online={relay.online ? 'true' : 'false'}
      data-relay-failing={relayFailing(relay) ? 'true' : 'false'}
    >
      {selectable && !relay.attached ? (
        <button
          type="button"
          className="flex w-fit items-center gap-2 rounded-md py-0.5 text-left transition-opacity duration-(--tmex-motion-fast) hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
          onClick={() => onSelect?.(relay)}
          data-testid={`nodes-relay-switch-${host}`}
        >
          {line}
        </button>
      ) : (
        <span
          className="flex w-fit items-center gap-2 py-0.5"
          aria-current={selectable ? 'true' : undefined}
        >
          {line}
        </span>
      )}
      {relay.kicked && (
        <span className="text-[11px] text-destructive" data-testid={`nodes-relay-kicked-${host}`}>
          {t('relay.tenant.strip.kicked')}
        </span>
      )}
      {errorKey && (
        <span className="text-[11px] text-destructive" data-testid={`nodes-relay-error-${host}`}>
          {t('relay.tenant.strip.error', { message: t(errorKey) })}
        </span>
      )}
    </div>
  );
}

function RelayLine({
  relay,
  host,
  current,
}: {
  relay: RelayLinkStatus;
  host: string;
  current: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <span
        className={cn(
          'min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]',
          current && 'ring-1 ring-primary'
        )}
        data-testid={`nodes-relay-host-${host}`}
      >
        {host}
      </span>
      {current && <Check className="size-3 shrink-0 text-primary" aria-hidden />}
      <Badge
        variant={relay.online ? 'default' : 'outline'}
        data-testid={`nodes-relay-status-${host}`}
      >
        {relayStatusText(t, relay)}
      </Badge>
    </>
  );
}

function relayStatusText(
  t: (key: string, options?: Record<string, unknown>) => string,
  relay: RelayLinkStatus
): string {
  if (!relay.online) return t('relay.tenant.strip.offline');
  if (typeof relay.rttMs === 'number') return t('relay.tenant.strip.rtt', { ms: relay.rttMs });
  return t('relay.tenant.strip.online');
}
