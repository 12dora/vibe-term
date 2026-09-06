// 接入节点表：一行一个成员。租户表管「谁被允许接入」，这张表管「此刻谁在转发」。
// 排序与筛选由调用方（members-card）持有，本文件只摆版式并把表头点击回传。

import { formatRate } from '@vibeterm/api-client/format';
import type { RelayMetricsMember } from '@vibeterm/api-client/relay/metrics-types';
import { Badge } from '@vibeterm/ui/badge';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { WideTableScroll } from '../components/wide-table';
import { formatMs, relativeTimeText } from './relay-format';
import {
  type MemberSort,
  type MemberSortKey,
  levelTone,
  memberTitle,
  rttLevel,
} from './relay-metrics-model';

const RTT_TONE_CLASS = {
  default: '',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
} as const;

/** 速率列固定宽度：两个读数各自等宽还不够，列本身也要定死，否则整表随刷新重排。 */
const RATE_COLUMN_CLASS = 'w-[11rem] min-w-[11rem]';

const COLUMNS: { key: MemberSortKey; align: 'left' | 'right'; className?: string }[] = [
  { key: 'node', align: 'left' },
  { key: 'state', align: 'left' },
  { key: 'rtt', align: 'right' },
  { key: 'streams', align: 'right' },
  { key: 'rate', align: 'right', className: RATE_COLUMN_CLASS },
  { key: 'reconnects', align: 'right' },
  { key: 'connected', align: 'left' },
];

export interface RelayMembersTableProps {
  /** 已由调用方筛过、排过序的行。 */
  members: RelayMetricsMember[];
  /** 相对时间的基准，由调用方按刷新节奏推进。 */
  now: number;
  sort: MemberSort;
  onSort: (key: MemberSortKey) => void;
  /** 本来有成员，只是被检索条件筛没了：空态换一句话。 */
  filtered?: boolean;
}

export function RelayMembersTable({
  members,
  now,
  sort,
  onSort,
  filtered = false,
}: RelayMembersTableProps) {
  const { t } = useTranslation();
  return (
    <WideTableScroll>
      <table className="w-full min-w-[46rem] text-xs" data-testid="relay-members-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            {COLUMNS.map((column) => (
              <SortableTh
                key={column.key}
                column={column.key}
                align={column.align}
                className={column.className}
                sort={sort}
                onSort={onSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <MemberRow key={`${member.tenantId}:${member.nodeId}`} member={member} now={now} />
          ))}
          {members.length === 0 && (
            <tr>
              <td
                colSpan={COLUMNS.length}
                className="vibeterm-fade px-3 py-6 text-center text-muted-foreground"
                data-testid={filtered ? 'relay-members-no-match' : 'relay-members-empty'}
              >
                {t(filtered ? 'relay.metrics.members.noMatch' : 'relay.metrics.members.empty')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </WideTableScroll>
  );
}

function MemberRow({ member, now }: { member: RelayMetricsMember; now: number }) {
  const { t } = useTranslation();
  const rtt = member.online ? member.rttMs : null;
  return (
    <tr
      className="border-b border-border/60 last:border-0"
      data-testid={`relay-member-row-${member.nodeId}`}
      data-online={member.online ? '' : undefined}
    >
      <Td>
        <span className="truncate font-medium" title={member.nodeId}>
          {memberTitle(member)}
        </span>
      </Td>
      <Td>
        <Badge variant={member.online ? 'default' : 'outline'}>
          {t(member.online ? 'relay.metrics.members.online' : 'relay.metrics.members.offline')}
        </Badge>
      </Td>
      <Td align="right" className={RTT_TONE_CLASS[levelTone(rttLevel(rtt))]}>
        {formatMs(rtt)}
      </Td>
      <Td align="right">{member.activeStreams}</Td>
      <Td align="right" className={RATE_COLUMN_CLASS}>
        {/* 出 / 入两个读数各自包一层：整句插值成一个字符串就没法让两半分别定宽。
            ↑ ↓ · 三个符号与语言无关，沿用 relay.metrics.tiles.throughputSub 的排法。 */}
        <span className="inline-flex items-center justify-end gap-1 whitespace-nowrap">
          <span aria-hidden>↑</span>
          <ByteRate>{formatRate(member.bytesOutPerSec)}</ByteRate>
          <span aria-hidden>·</span>
          <span aria-hidden>↓</span>
          <ByteRate>{formatRate(member.bytesInPerSec)}</ByteRate>
        </span>
      </Td>
      <Td align="right">{member.reconnects}</Td>
      <Td>
        {member.connectedAt === null
          ? t('relay.metrics.members.never')
          : relativeTimeText(t, member.connectedAt, now)}
      </Td>
    </tr>
  );
}

function SortableTh({
  column,
  align,
  className = '',
  sort,
  onSort,
}: {
  column: MemberSortKey;
  align: 'left' | 'right';
  className?: string;
  sort: MemberSort;
  onSort: (key: MemberSortKey) => void;
}) {
  const { t } = useTranslation();
  const active = sort.key === column;
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={`px-3 py-2 font-normal ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
      scope="col"
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground ${
          active ? 'text-foreground' : ''
        }`}
        onClick={() => onSort(column)}
        data-testid={`relay-members-sort-${column}`}
      >
        {t(`relay.metrics.members.columns.${column}`)}
        {active && <Arrow className="size-3" aria-hidden />}
      </button>
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className = '',
}: { children: React.ReactNode; align?: 'left' | 'right'; className?: string }) {
  return (
    <td
      className={`px-3 py-2 tabular-nums ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}
    >
      {children}
    </td>
  );
}
