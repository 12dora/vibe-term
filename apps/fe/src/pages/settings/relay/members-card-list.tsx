// 接入节点表在 sm 以下的版式：一个成员一张记录卡。
//
// 宽表七列（节点 / 状态 / 延迟 / 活跃流 / 速率 / 重连 / 连接于），390px 下只能横滚。
// 卡片摊成：标题行（名称 + 在线标记）、延迟、可折行的出/入速率、其余弱化信息。
// testid 与宽表同一套，调用方按 `useNarrowLayout()` 二选一渲染。

import {
  RecordCard,
  RecordCardEmpty,
  RecordCardFacts,
  RecordCardList,
  RecordCardMeta,
  RecordCardTitle,
} from '@/components/record-card';
import { TONE_CLASS } from '@/lib/tone';
import { formatRate } from '@vibeterm/api-client/format';
import type { RelayMetricsMember } from '@vibeterm/api-client/relay/metrics-types';
import { Badge } from '@vibeterm/ui/badge';
import { ByteRate } from '@vibeterm/ui/byte-rate';
import { useTranslation } from 'react-i18next';
import { formatMs, relativeTimeText } from './relay-format';
import { levelTone, memberTitle, rttLevel } from './relay-metrics-model';

const RTT_TONE_CLASS = {
  default: '',
  warning: TONE_CLASS.text.warn,
  destructive: TONE_CLASS.text.blocked,
} as const;

export function RelayMembersCardList({
  members,
  now,
  filtered = false,
}: {
  members: RelayMetricsMember[];
  now: number;
  filtered?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <RecordCardList testId="relay-members-table">
      {members.map((member) => (
        <MemberCard key={`${member.tenantId}:${member.nodeId}`} member={member} now={now} />
      ))}
      {members.length === 0 && (
        <RecordCardEmpty testId={filtered ? 'relay-members-no-match' : 'relay-members-empty'}>
          {t(filtered ? 'relay.metrics.members.noMatch' : 'relay.metrics.members.empty')}
        </RecordCardEmpty>
      )}
    </RecordCardList>
  );
}

function MemberCard({ member, now }: { member: RelayMetricsMember; now: number }) {
  const { t } = useTranslation();
  const rtt = member.online ? member.rttMs : null;
  return (
    <RecordCard testId={`relay-member-row-${member.nodeId}`}>
      <RecordCardTitle>
        <span className="min-w-0 truncate font-medium" title={member.nodeId}>
          {memberTitle(member)}
        </span>
        <Badge variant={member.online ? 'default' : 'outline'}>
          {t(member.online ? 'relay.metrics.members.online' : 'relay.metrics.members.offline')}
        </Badge>
      </RecordCardTitle>
      <RecordCardFacts label={t('relay.metrics.members.columns.rtt')}>
        <span className={RTT_TONE_CLASS[levelTone(rttLevel(rtt))]}>{formatMs(rtt)}</span>
      </RecordCardFacts>
      <RecordCardFacts label={t('relay.metrics.members.columns.rate')}>
        <MemberRate member={member} />
      </RecordCardFacts>
      <RecordCardMeta>
        <span>
          {t('relay.metrics.members.columns.streams')} {member.activeStreams}
        </span>
        <span>
          {t('relay.metrics.members.columns.reconnects')} {member.reconnects}
        </span>
        <span>
          {t('relay.metrics.members.columns.connected')}{' '}
          {member.connectedAt === null
            ? t('relay.metrics.members.never')
            : relativeTimeText(t, member.connectedAt, now)}
        </span>
      </RecordCardMeta>
    </RecordCard>
  );
}

function MemberRate({ member }: { member: RelayMetricsMember }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span aria-hidden>↑</span>
      <span className="sr-only">{t('common.direction.out')}</span>
      <ByteRate align="left" minWidthClass="min-w-0">
        {formatRate(member.bytesOutPerSec)}
      </ByteRate>
      <span aria-hidden>·</span>
      <span aria-hidden>↓</span>
      <span className="sr-only">{t('common.direction.in')}</span>
      <ByteRate align="left" minWidthClass="min-w-0">
        {formatRate(member.bytesInPerSec)}
      </ByteRate>
    </span>
  );
}
