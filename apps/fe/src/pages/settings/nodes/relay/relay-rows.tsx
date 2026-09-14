// 中继链路：一条一行。错误按稳定错误码查表，原始错误串（`ECONNRESET` 之类）从不上屏。
//
// 两种形态（判据见 `relay-row-model.ts` 的 `isMultiAttachView`）：
// - 单条中继 / 旧网关：一个状态点加一个主机名。多于一条时行本身是选择器，点哪条切哪条。
// - 多条同时挂载：每条都连着，行不再是单选——默认只摆身份与延迟，「更多」收其余事实，
//   行尾一个「设为主中继」，主中继那条禁用。

import { TONE_CLASS } from '@/lib/tone';
import type { RelayLinkStatus } from '@vibeterm/api-client/relay/tenant-api';
import { Tooltip, cn } from '@vibeterm/ui';
import { Button } from '@vibeterm/ui/button';
import { useTranslation } from 'react-i18next';
import { type SegmentItem, Segments } from '../copy-feedback';
import {
  type RelayBadgeSpec,
  type RelayTipLine,
  canSetPrimary,
  isMultiAttachView,
  relayFailing,
  relayLinkErrorKey,
  relayMoreTipLines,
  relayRoleBadge,
  relayRttBadge,
} from './relay-row-model';

export { relayFailing, relayLinkErrorKey };

/** 行首正文：主机名（带端口）；地址畸形时退回原串。 */
export function relayLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
  const more = <RelayMoreTip relay={relay} host={host} />;
  const line = (
    <RelayLine
      relay={relay}
      host={host}
      current={selectable && relay.attached}
      selectable={selectable}
    />
  );
  return (
    <RelayRowShell relay={relay} host={host}>
      {selectable && !relay.attached ? (
        <span className="flex w-fit items-center gap-2">
          <button
            type="button"
            className="flex w-fit items-center gap-2 rounded-md py-0.5 text-left transition-opacity duration-(--vibeterm-motion-fast) hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            onClick={() => onSelect?.(relay)}
            data-testid={`nodes-relay-switch-${host}`}
          >
            {line}
          </button>
          {more}
        </span>
      ) : (
        <span
          className="flex w-fit items-center gap-2 py-0.5"
          aria-current={selectable ? 'true' : undefined}
        >
          {line}
          {more}
        </span>
      )}
    </RelayRowShell>
  );
}

/** 多条同时挂载时的一行：身份 · 延迟 · 更多，行尾一个「设为主中继」。 */
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
  return (
    <RelayRowShell relay={relay} host={host}>
      <span
        className="flex min-w-0 flex-col gap-1 py-0.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1.5 sm:gap-y-0.5"
        data-relay-role={role.key}
        aria-current={relay.attached ? 'true' : undefined}
      >
        <Segments items={attachedSegments(relay, host, role)} />
        {onSelect && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="self-end sm:ml-auto sm:self-auto"
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

/** 一条中继的默认段：主机名打头，随后是身份 / 延迟 / 更多。 */
function attachedSegments(
  relay: RelayLinkStatus,
  host: string,
  role: RelayBadgeSpec
): SegmentItem[] {
  const rtt = relayRttBadge(relay);
  const items: SegmentItem[] = [
    {
      key: 'host',
      node: (
        <span className="flex min-w-0 items-center gap-1.5">
          <RelayDot relay={relay} host={host} />
          <RelayHost host={host} current={relay.attached === true} />
        </span>
      ),
    },
    {
      key: 'role',
      node: <RelayFact spec={role} testId={`nodes-relay-role-${host}`} />,
    },
  ];
  if (rtt) {
    items.push({ key: 'rtt', node: <RelayFact spec={rtt} testId={`nodes-relay-rtt-${host}`} /> });
  }
  items.push({ key: 'more', node: <RelayMoreTip relay={relay} host={host} /> });
  return items;
}

function RelayMoreTip({ relay, host }: { relay: RelayLinkStatus; host: string }) {
  const { t } = useTranslation();
  const lines = relayMoreTipLines(relay, host);
  if (lines.length === 0) return null;
  return (
    <Tooltip
      side="bottom"
      content={
        <span
          className="flex flex-col gap-0.5 text-left"
          data-testid={`nodes-relay-more-tip-${host}`}
        >
          {lines.map((line) => (
            <span key={line.key} className={tipLineClass(line)} data-testid={line.testId}>
              {tipLineText(t, line)}
            </span>
          ))}
        </span>
      }
    >
      <Button type="button" size="xs" variant="ghost" data-testid={`nodes-relay-more-${host}`}>
        {t('relay.tenant.strip.more')}
      </Button>
    </Tooltip>
  );
}

function tipLineText(t: ReturnType<typeof useTranslation>['t'], line: RelayTipLine): string {
  const translated = line.translatedParams
    ? Object.fromEntries(Object.entries(line.translatedParams).map(([name, key]) => [name, t(key)]))
    : {};
  return t(line.i18nKey, { ...line.params, ...translated });
}

function tipLineClass(line: RelayTipLine): string {
  if (line.tone === 'destructive') return TONE_CLASS.text.blocked;
  if (line.tone === 'warning') return TONE_CLASS.text.warn;
  return '';
}

function RelayFact({ spec, testId }: { spec: RelayBadgeSpec; testId: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={`whitespace-nowrap${spec.variant === 'default' ? '' : ' text-muted-foreground'}`}
      data-testid={testId}
    >
      {t(spec.key, spec.params)}
    </span>
  );
}

/**
 * 链路状态点：在线 / 离线 / 令牌已失效。`title` 与 `aria-label` 承载读屏文案。
 *
 * 被踢先判：令牌作废时链路可能还报着 `online`，照在线那一档写标签会得到一个红点配「在线」。
 */
function RelayDot({ relay, host }: { relay: RelayLinkStatus; host: string }) {
  const { t } = useTranslation();
  const failing = relay.kicked === true || !relay.online;
  const label = t(dotLabelKey(relay));
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

function dotLabelKey(relay: RelayLinkStatus): string {
  if (relay.kicked === true) return 'nodes.machine.status.relayKicked';
  return relay.online ? 'relay.tenant.strip.online' : 'relay.tenant.strip.offline';
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
  selectable,
}: {
  relay: RelayLinkStatus;
  host: string;
  current: boolean;
  selectable: boolean;
}) {
  return (
    <>
      <RelayDot relay={relay} host={host} />
      <RelayHost host={host} current={current} />
      {selectable && <RelayCandidateFact relay={relay} host={host} />}
    </>
  );
}

/**
 * 行是选择器时，光一个 6px 的点不足以让人挑中继：离线与延迟必须是看得见的文字。
 * 只有一条中继（行不可选）时不摆——卡头那枚徽标已经说过同一件事。
 */
function RelayCandidateFact({ relay, host }: { relay: RelayLinkStatus; host: string }) {
  const { t } = useTranslation();
  if (!relay.online) {
    return (
      <span
        className={`whitespace-nowrap ${TONE_CLASS.text.blocked}`}
        data-testid={`nodes-relay-offline-${host}`}
      >
        {t('relay.tenant.strip.offline')}
      </span>
    );
  }
  const rtt = relayRttBadge(relay);
  if (!rtt) return null;
  return (
    <span
      className="whitespace-nowrap text-muted-foreground"
      data-testid={`nodes-relay-rtt-${host}`}
    >
      {t(rtt.key, rtt.params)}
    </span>
  );
}
