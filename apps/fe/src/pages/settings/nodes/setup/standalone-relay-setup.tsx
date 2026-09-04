// standalone 下「接入中继」tab 的两条路：加入别人的中继，或把本机变成中继。
//
// 两块并排摆在同一个插槽里（本机卡的 `relaySetup`）：先给更常见的「加入」，再给「作为中继」，
// 各自带一行小标题，免得两张表单的字段混成一片。

import type { LocalStatusResponse, SetupRelayRole } from '@tmex/api-client/local/types';
import { useTranslation } from 'react-i18next';
import { BecomeRelayForm } from './become-relay-form';
import { JoinRelayForm } from './join-relay-form';

export interface StandaloneRelaySetupProps {
  localStatus: LocalStatusResponse;
  /** 「本机作为中继」表单的预选角色（跨重启记号带来的）。 */
  initialRole?: SetupRelayRole;
}

function SetupChoice({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="space-y-1 rounded-xl bg-card p-1 ring-1 ring-foreground/10"
      data-testid={testId}
    >
      <h4 className="px-2 pt-2 text-sm font-medium">{title}</h4>
      {children}
    </section>
  );
}

export function StandaloneRelaySetup({ localStatus, initialRole }: StandaloneRelaySetupProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="setup-relay-choices">
      <SetupChoice testId="setup-relay-choice-join" title={t('nodes.setup.path.joinRelay.title')}>
        <JoinRelayForm localStatus={localStatus} />
      </SetupChoice>
      <SetupChoice testId="setup-relay-choice-host" title={t('nodes.setup.path.becomeRelay.title')}>
        <BecomeRelayForm localStatus={localStatus} {...(initialRole ? { initialRole } : {})} />
      </SetupChoice>
    </div>
  );
}
