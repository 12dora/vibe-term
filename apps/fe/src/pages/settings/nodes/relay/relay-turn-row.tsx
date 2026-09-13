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
import { Row } from '../copy-feedback';

export function RelayTurnRow({ turn }: { turn: RelayTurnStatus }) {
  const { t } = useTranslation();
  const view = relayTurnView(turn);
  const probe = view.membersProbe;
  const facts = [
    t(view.stateKey),
    t(view.modeKey),
    ...(view.endpoint ? [view.endpoint] : []),
    ...(view.externalIp ? [t('relay.admin.turn.externalIp', { ip: view.externalIp })] : []),
  ];
  return (
    <Row label={t('relay.admin.turn.title')} testId="relay-turn">
      <span className="min-w-0 break-all" data-testid="relay-turn-endpoint">
        {facts.join(' · ')}
      </span>
      {probe && (
        <span className={probeClass(probe)} data-testid="relay-turn-members-probe">
          {`· ${t('relay.admin.turn.membersProbe', { ok: probe.ok, total: probe.total })}`}
        </span>
      )}
      {view.error && (
        <span
          className={`basis-full break-all ${TONE_CLASS.text.blocked}`}
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
