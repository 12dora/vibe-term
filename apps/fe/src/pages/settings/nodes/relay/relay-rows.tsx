// 中继链路：一条一行。错误按稳定错误码查表，原始错误串（`ECONNRESET` 之类）从不上屏。
//
// 两种形态（判据见 `relay-row-model.ts` 的 `isMultiAttachView`）：
// - 单条中继 / 旧网关：行内只留地址与一枚状态徽标；多于一条时行本身是选择器，点哪条切哪条。
// - 多条同时挂载：每条都连着，行不再是单选——各自摆身份、延迟、在线对端数与 TURN，
//   行尾一个「设为主中继」，主中继那条禁用。

import type { RelayLinkErrorCode, RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { cn } from '@vibeterm/ui';
import { Badge } from '@vibeterm/ui/badge';
import { Button } from '@vibeterm/ui/button';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  type RelayBadgeSpec,
  type RelayTurnChipTone,
  canSetPrimary,
  isMultiAttachView,
  relayPeersBadge,
  relayRoleBadge,
  relayRttBadge,
  relayTurnChip,
} from './relay-row-model';

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
  'revoked',
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
  /** 传了且多于一条时可切主：单挂载形态是点行，多挂载形态是行尾的按钮。 */
  onSelect?: (relay: RelayLinkStatus) => void;
  /** 网关报告本机同时挂着多条中继；缺席（旧网关）按单挂载渲染。 */
  multiAttach?: boolean;
}

export function RelayRows({ relays, onSelect, multiAttach }: RelayRowsProps) {
  const { t } = useTranslation();
  if (relays.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="nodes-relay-empty">
        {t('relay.tenant.strip.empty')}
      </p>
    );
  }
  const multi = isMultiAttachView(multiAttach, relays);
  const selectable = relays.length > 1 && onSelect !== undefined;
  return (
    <div className="flex flex-col gap-1" data-testid="nodes-relay-rows">
      {relays.map((relay) =>
        multi ? (
          <RelayAttachedRow key={relay.url} relay={relay} onSelect={onSelect} />
        ) : (
          <RelayRow key={relay.url} relay={relay} selectable={selectable} onSelect={onSelect} />
        )
      )}
    </div>
  );
}

/** 行外壳：`data-*` 是各屏单测与 e2e 的抓手，两种形态共用同一套。 */
function RelayRowShell({
  relay,
  host,
  children,
}: {
  relay: RelayLinkStatus;
  host: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const errorKey = relayLinkErrorKey(relay);
  return (
    <div
      className="flex flex-col gap-0.5"
      data-testid={`nodes-relay-row-${host}`}
      data-relay-attached={relay.attached ? 'true' : 'false'}
      data-relay-online={relay.online ? 'true' : 'false'}
      data-relay-failing={relayFailing(relay) ? 'true' : 'false'}
    >
      {children}
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

function RelayRow({
  relay,
  selectable,
  onSelect,
}: {
  relay: RelayLinkStatus;
  selectable: boolean;
  onSelect?: (relay: RelayLinkStatus) => void;
}) {
  const host = relayLabel(relay.url);
  const line = <RelayLine relay={relay} host={host} current={selectable && relay.attached} />;
  return (
    <RelayRowShell relay={relay} host={host}>
      {selectable && !relay.attached ? (
        <button
          type="button"
          className="flex w-fit items-center gap-2 rounded-md py-0.5 text-left transition-opacity duration-(--vibeterm-motion-fast) hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
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
    </RelayRowShell>
  );
}

/** 多条同时挂载时的一行：身份 / 延迟 / 在线对端数 / TURN 各一枚，行尾一个「设为主中继」。 */
function RelayAttachedRow({
  relay,
  onSelect,
}: {
  relay: RelayLinkStatus;
  onSelect?: (relay: RelayLinkStatus) => void;
}) {
  const { t } = useTranslation();
  const host = relayLabel(relay.url);
  const role = relayRoleBadge(relay);
  const rtt = relayRttBadge(relay);
  const peers = relayPeersBadge(relay);
  const turn = relayTurnChip(relay);
  return (
    <RelayRowShell relay={relay} host={host}>
      <span
        className="flex flex-wrap items-center gap-2 py-0.5"
        data-relay-role={role.key}
        aria-current={relay.attached ? 'true' : undefined}
      >
        <span
          className={cn(
            'min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]',
            relay.attached && 'ring-1 ring-primary'
          )}
          data-testid={`nodes-relay-host-${host}`}
        >
          {host}
        </span>
        <RowBadge spec={role} testId={`nodes-relay-role-${host}`} />
        {rtt && <RowBadge spec={rtt} testId={`nodes-relay-rtt-${host}`} />}
        {peers && <RowBadge spec={peers} testId={`nodes-relay-peers-${host}`} />}
        {turn && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-none',
              turnChipClass(turn.tone)
            )}
            title={turn.titleKey ? t(turn.titleKey) : undefined}
            data-testid={`nodes-relay-turn-${host}`}
          >
            <span className="text-muted-foreground">{t('relay.tenant.strip.turn')}</span>
            <span className="min-w-0 truncate font-mono">{turn.endpoint}</span>
            <span className={turn.tone === 'default' ? 'text-muted-foreground' : undefined}>
              {t(turn.verdictKey)}
              {turn.membersKey ? ` · ${t(turn.membersKey, turn.membersParams)}` : ''}
            </span>
          </span>
        )}
        {onSelect && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={!canSetPrimary(relay)}
            onClick={() => onSelect(relay)}
            data-testid={`nodes-relay-switch-${host}`}
          >
            {t('relay.tenant.switch.setPrimary')}
          </Button>
        )}
      </span>
    </RelayRowShell>
  );
}

function turnChipClass(tone: RelayTurnChipTone): string {
  if (tone === 'destructive') return 'border-destructive/40 text-destructive';
  if (tone === 'warning') return 'border-amber-500/40 text-amber-700 dark:text-amber-400';
  return 'border-border';
}

function RowBadge({ spec, testId }: { spec: RelayBadgeSpec; testId: string }) {
  const { t } = useTranslation();
  return (
    <Badge variant={spec.variant} data-testid={testId}>
      {t(spec.key, spec.params)}
    </Badge>
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
