// 本机卡上的 TURN 一行：状态 · 来源 · 地址 · 外网 IP · 成员可达。
//
// 运营面板那一格（`pages/settings/relay/relay-turn-tile.tsx`）留给「中继」标签，这里只回答
// 「开着没有、地址是什么、成员打得通吗」；端口放行那句由「网络」段的端口行负责，不重复。

import { TONE_CLASS } from '@/lib/tone';
import { useTranslation } from 'react-i18next';
import {
  type RelayTurnStatus,
  membersProbeTone,
  relayTurnView,
} from '../../relay/relay-turn-model';
import { Row, type SegmentItem, Segments } from '../copy-feedback';

export function RelayTurnRow({ turn }: { turn: RelayTurnStatus }) {
  const { t } = useTranslation();
  const view = relayTurnView(turn);
  const probe = view.membersProbe;
  const items: SegmentItem[] = [
    { key: 'state', node: <span className="whitespace-nowrap">{t(view.stateKey)}</span> },
    { key: 'mode', node: <span className="whitespace-nowrap">{t(view.modeKey)}</span> },
  ];
  if (view.endpoint) {
    items.push({
      key: 'endpoint',
      node: (
        <span
          className="min-w-0 truncate font-mono"
          title={view.endpoint}
          data-testid="relay-turn-endpoint"
        >
          {view.endpoint}
        </span>
      ),
    });
  }
  if (view.externalIp) {
    items.push({
      key: 'external-ip',
      node: (
        <span className="min-w-0 truncate">
          {t('relay.admin.turn.externalIp', { ip: view.externalIp })}
        </span>
      ),
    });
  }
  if (probe) {
    items.push({
      key: 'members-probe',
      node: (
        <span
          className={`whitespace-nowrap ${probeClass(probe)}`}
          data-testid="relay-turn-members-probe"
        >
          {t('relay.admin.turn.membersProbe', { ok: probe.ok, total: probe.total })}
        </span>
      ),
    });
  }
  return (
    <Row label={t('relay.admin.turn.title')} testId="relay-turn">
      <Segments items={items} className="w-full" />
      {view.error && (
        <span
          className={`basis-full break-words ${TONE_CLASS.text.blocked}`}
          data-testid="relay-turn-error"
        >
          {t('relay.admin.turn.failed', { message: view.error })}
        </span>
      )}
    </Row>
  );
}

function probeClass(probe: NonNullable<ReturnType<typeof relayTurnView>['membersProbe']>): string {
  const tone = membersProbeTone(probe);
  if (tone === 'destructive') return TONE_CLASS.text.blocked;
  if (tone === 'warning') return TONE_CLASS.text.warn;
  return TONE_CLASS.text.muted;
}
