// 「连接」段的中继形态：一行「中继」摆链路，下面是一摞提醒。
//
// 追加中继 / 重新输入接入密码 / 逐条移除 / 离开中继全部收进卡片 ⋯ 菜单（`connect-menu.ts`）：
// 它们低频且各自带确认，摆在卡面上只会和「现在连着谁」抢版面。
//
// 多条中继时切换不在菜单里：单挂载下链路行本身就是选择器，点哪条就切到哪条；
// 多条同时挂载时行不再是单选，改由行尾的「设为主中继」发起（见 `relay-rows.tsx`）。
// 「设为主中继」会把那条固定住，取消固定（恢复自动优选）是链路行下面那一行的事。

import type { UseMeshRelayResult } from '@/node/mesh-relay';
import { useTranslation } from 'react-i18next';
import { Notice, NoticeAction } from '../card-parts';
import { Row } from '../copy-feedback';
import { RelayAutoSelectLine } from '../relay/relay-auto-select';
import { relayNotices } from '../relay/relay-notices';
import { RelayRows } from '../relay/relay-rows';
import { RelaySwitchDialog } from '../relay/relay-switch-dialog';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { useRelaySwitch } from '../relay/use-relay-switch';
import { reauthTarget } from './relay-targets';

export interface RelayUplinkPanelProps {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}

export function RelayUplinkPanel({ relay, actions }: RelayUplinkPanelProps) {
  const { t } = useTranslation();
  const { refresh } = relay;
  const multiAttach = relay.multiAttach === true;
  const switching = useRelaySwitch({ onChanged: refresh, multiAttach });
  return (
    <div className="flex flex-col gap-3" data-testid="local-uplink-relay-panel">
      <Row label={t('nodes.machine.upstream')}>
        <RelayRows relays={relay.ordered} onSelect={switching.request} multiAttach={multiAttach} />
      </Row>
      <RelayAutoSelectLine
        preferredUrl={relay.preferredUrl}
        autoSelect={relay.autoSelect}
        multiAttach={multiAttach}
      />
      <RelaySwitchDialog controller={switching} multiAttach={multiAttach} />
      <RelayNoticeList relay={relay} actions={actions} />
    </div>
  );
}

function RelayNoticeList({
  relay,
  actions,
}: {
  relay: UseMeshRelayResult;
  actions: RelayActionsController;
}) {
  const { t } = useTranslation();
  const notices = relayNotices({
    kicked: relay.kicked,
    readmitPending: relay.readmitPending,
    metaPending: actions.metaPending.length,
    packPending: actions.packPending,
    writable: relay.writable,
  });
  const run = (kind: string) => {
    if (kind === 'kicked') actions.openEnroll('reauth', reauthTarget(relay.ordered) ?? '');
    else if (kind === 'readmit') void actions.readmitMembers();
    else if (kind === 'metaPending') void actions.retryMetaKey();
    else if (kind === 'packPending') void actions.retryPack();
  };
  return (
    <>
      {notices.map((notice) => (
        <Notice
          key={notice.kind}
          tone={notice.tone}
          testId={notice.testId}
          action={
            notice.action ? (
              <NoticeAction
                label={t(notice.action.key)}
                testId={notice.action.testId}
                disabled={actions.busy && notice.kind !== 'kicked'}
                onClick={() => run(notice.kind)}
              />
            ) : undefined
          }
        >
          {t(notice.key, notice.params)}
        </Notice>
      ))}
      {/*
        令牌换代：重新输入接入密码那条仍然摆着（本机也可能就是要去接入的那台），这条补足另一条出路。
        「重发中继令牌」是替**别人**做的——错过换发的成员节点手里没有接入密码，只能等这条
        `set-relays` 下来；hint 里那句 30 天是硬边界，过了就只剩用账号密码重新加入。
      */}
      {relay.awaitingToken && (
        <Notice
          tone="warning"
          testId="nodes-relay-awaiting-token"
          action={
            <NoticeAction
              label={t('relay.tenant.resendToken.action')}
              testId="nodes-relay-resend-token"
              disabled={actions.busy}
              onClick={() => void actions.resendToken()}
            />
          }
        >
          {t('relay.tenant.awaitingToken.notice')} {t('relay.tenant.awaitingToken.hint')}
        </Notice>
      )}
    </>
  );
}
