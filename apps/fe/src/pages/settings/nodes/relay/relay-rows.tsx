// 中继链路：一条一行。错误按稳定错误码查表，原始错误串（`ECONNRESET` 之类）从不上屏。
//
// 两种形态（判据见 `relay-row-model.ts` 的 `isMultiAttachView`）：
// - 单条中继 / 旧网关：一个状态点加一个主机名——「在线 / 延迟多少」卡头那枚徽标已经说过了。
//   多于一条时行本身是选择器，点哪条切哪条。
// - 多条同时挂载：每条都连着，行不再是单选——身份 / 延迟 / 在线对端数 / TURN 用 `·` 串成一句，
//   行尾一个「设为主中继」，主中继那条禁用。

import { TONE_CLASS } from '@/lib/tone';
import type { RelayLinkErrorCode, RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { useTranslation } from 'react-i18next';
import {
  type RelayBadgeSpec,
  type RelayTurnChip,
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
    return <span data-testid="nodes-relay-empty">{t('relay.tenant.strip.empty')}</span>;
  }
  const multi = isMultiAttachView(multiAttach, relays);
  const selectable = relays.length > 1 && onSelect !== undefined;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1" data-testid="nodes-relay-rows">
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
      className="flex min-w-0 flex-col gap-0.5"
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

/** 多条同时挂载时的一行：身份 · 延迟 · 在线对端数 · TURN 串成一句，行尾一个「设为主中继」。 */
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
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 py-0.5"
        data-relay-role={role.key}
        aria-current={relay.attached ? 'true' : undefined}
      >
        <RelayDot relay={relay} host={host} />
        <RelayHost host={host} current={relay.attached === true} />
        <RelayFact spec={role} testId={`nodes-relay-role-${host}`} />
        {rtt && <RelayFact spec={rtt} testId={`nodes-relay-rtt-${host}`} />}
        {peers && <RelayFact spec={peers} testId={`nodes-relay-peers-${host}`} />}
        {turn && (
          <>
            <Separator />
            <span
              className={turnTextClass(turn.tone)}
              title={turn.titleKey ? t(turn.titleKey) : undefined}
              data-testid={`nodes-relay-turn-${host}`}
            >
              {`${t('relay.tenant.strip.turn')} ${turn.endpoint} ${t(turn.verdictKey)}`}
              {turn.membersKey ? ` · ${t(turn.membersKey, turn.membersParams)}` : ''}
            </span>
          </>
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

function turnTextClass(tone: RelayTurnChip['tone']): string {
  if (tone === 'destructive') return TONE_CLASS.text.blocked;
  if (tone === 'warning') return TONE_CLASS.text.warn;
  return TONE_CLASS.text.muted;
}

/** 事实之间的分隔：`·` 只是标点，不进无障碍树。 */
function Separator() {
  return (
    <span className="text-muted-foreground/60" aria-hidden>
      ·
    </span>
  );
}

function RelayFact({ spec, testId }: { spec: RelayBadgeSpec; testId: string }) {
  const { t } = useTranslation();
  return (
    <>
      <Separator />
      <span className={spec.variant === 'default' ? undefined : 'text-muted-foreground'}>
        <span data-testid={testId}>{t(spec.key, spec.params)}</span>
      </span>
    </>
  );
}

/** 链路状态点：在线 / 离线 / 令牌已作废。`title` 与 `aria-label` 承载读屏文案。 */
function RelayDot({ relay, host }: { relay: RelayLinkStatus; host: string }) {
  const { t } = useTranslation();
  const failing = relay.kicked === true || !relay.online;
  const label = t(relay.online ? 'relay.tenant.strip.online' : 'relay.tenant.strip.offline');
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        failing ? TONE_CLASS.dot.blocked : TONE_CLASS.dot.ok
      )}
      title={label}
      aria-label={label}
      role="img"
      data-testid={`nodes-relay-status-${host}`}
    />
  );
}

function RelayHost({ host, current }: { host: string; current: boolean }) {
  return (
    <span
      className={cn('min-w-0 truncate font-mono', current && 'font-medium text-foreground')}
      data-testid={`nodes-relay-host-${host}`}
    >
      {host}
    </span>
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
  return (
    <>
      <RelayDot relay={relay} host={host} />
      <RelayHost host={host} current={current} />
    </>
  );
}
