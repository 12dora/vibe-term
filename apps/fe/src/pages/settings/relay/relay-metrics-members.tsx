// 接入节点表：在线优先，一行一个成员。租户表管「谁被允许接入」，这张表管「此刻谁在转发」。

import type { RelayMetricsMember } from '@tmex/api-client/relay/metrics-types';
import { Badge } from '@tmex/ui/badge';
import { useTranslation } from 'react-i18next';
import { WideTableScroll } from '../components/wide-table';
import { formatBytesPerSec, formatMs, relativeTimeText } from './relay-format';
import { levelTone, memberTitle, rttLevel, sortMembers } from './relay-metrics-model';

const RTT_TONE_CLASS = {
  default: '',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
} as const;

export interface RelayMembersTableProps {
  members: RelayMetricsMember[];
  /** 相对时间的基准，由调用方按刷新节奏推进。 */
  now: number;
}

export function RelayMembersTable({ members, now }: RelayMembersTableProps) {
  const { t } = useTranslation();
  const rows = sortMembers(members);
  return (
    <WideTableScroll>
      <table className="w-full min-w-[46rem] text-xs" data-testid="relay-members-table">
        <thead className="text-muted-foreground">
          <tr className="border-b border-border">
            <Th>{t('relay.metrics.members.columns.node')}</Th>
            <Th>{t('relay.metrics.members.columns.state')}</Th>
            <Th align="right">{t('relay.metrics.members.columns.rtt')}</Th>
            <Th align="right">{t('relay.metrics.members.columns.streams')}</Th>
            <Th align="right">{t('relay.metrics.members.columns.rate')}</Th>
            <Th align="right">{t('relay.metrics.members.columns.reconnects')}</Th>
            <Th>{t('relay.metrics.members.columns.connected')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((member) => (
            <MemberRow key={`${member.tenantId}:${member.nodeId}`} member={member} now={now} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="tmex-fade px-3 py-6 text-center text-muted-foreground">
                {t('relay.metrics.members.empty')}
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
      <Td align="right">
        <span className="whitespace-nowrap">
          {t('relay.metrics.tiles.throughputSub', {
            out: formatBytesPerSec(member.bytesOutPerSec),
            in: formatBytesPerSec(member.bytesInPerSec),
          })}
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

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={`px-3 py-2 font-normal ${align === 'right' ? 'text-right' : 'text-left'}`}
      scope="col"
    >
      {children}
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
