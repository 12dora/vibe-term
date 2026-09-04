// 「本机自建中继」子路径：本机设为中继 → 设置接入密码 → 让新机器加入。
// 前两步的现状来自 `/api/local/status`（角色与 relay.hasPassword），拿不到时一律按待办渲染。

import { Button } from '@tmex/ui/button';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { isRelayRole } from './connect-path';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import type { ConnectMachine } from './use-connect-machine';

const PREFIX = 'connectDevices.computer.relayHost';

/** 一级选择占第 1 步，本机自建的步骤从 2 开始。 */
export const RELAY_HOST_STEP_OFFSET = 2;

function SetupStep({ machine, index }: { machine: ConnectMachine; index: number }) {
  const { t } = useTranslation();
  const isRelay = isRelayRole(machine.role);
  if (!isRelay) {
    return (
      <GuideStep
        index={index}
        testId="connect-step-relay-setup"
        title={t(`${PREFIX}.setup.title`)}
        description={t(`${PREFIX}.setup.description`)}
      >
        <GuideLink to="/settings?tab=nodes" testId="connect-relay-setup-link">
          {t(`${PREFIX}.setup.link`)}
        </GuideLink>
      </GuideStep>
    );
  }
  return (
    <GuideStep
      index={index}
      state="done"
      testId="connect-step-relay-setup"
      title={t(`${PREFIX}.setup.title`)}
    >
      {machine.relayPublicUrl ? (
        <CommandBlock
          value={machine.relayPublicUrl}
          testId="relay-public-url"
          label={t(`${PREFIX}.setup.urlLabel`)}
        />
      ) : (
        <GuideNote tone="warning" testId="connect-relay-missing-url">
          {t(`${PREFIX}.setup.missingUrl`)}
        </GuideNote>
      )}
    </GuideStep>
  );
}

function PasswordStep({ machine, index }: { machine: ConnectMachine; index: number }) {
  const { t } = useTranslation();
  if (machine.relayHasPassword) {
    return (
      <GuideStep
        index={index}
        state="done"
        testId="connect-step-relay-password"
        title={t(`${PREFIX}.password.title`)}
      >
        <GuideNote testId="connect-relay-password-done">{t(`${PREFIX}.password.done`)}</GuideNote>
      </GuideStep>
    );
  }
  return (
    <GuideStep
      index={index}
      testId="connect-step-relay-password"
      title={t(`${PREFIX}.password.title`)}
      description={t(`${PREFIX}.password.description`)}
    >
      {isRelayRole(machine.role) && (
        <GuideLink to="/settings?tab=relay" testId="connect-relay-password-link">
          {t(`${PREFIX}.password.link`)}
        </GuideLink>
      )}
    </GuideStep>
  );
}

function InviteStep({ index, onSwitchToJoin }: { index: number; onSwitchToJoin: () => void }) {
  const { t } = useTranslation();
  return (
    <GuideStep
      index={index}
      testId="connect-step-relay-invite"
      title={t(`${PREFIX}.invite.title`)}
      description={t(`${PREFIX}.invite.description`)}
    >
      <Button
        size="xs"
        variant="outline"
        data-testid="connect-relay-goto-join"
        onClick={onSwitchToJoin}
      >
        {t(`${PREFIX}.invite.gotoJoin`)}
      </Button>
    </GuideStep>
  );
}

export function RelayHostSteps({
  machine,
  onSwitchToJoin,
  startIndex = RELAY_HOST_STEP_OFFSET,
}: {
  machine: ConnectMachine;
  onSwitchToJoin: () => void;
  startIndex?: number;
}) {
  return (
    <>
      <SetupStep machine={machine} index={startIndex} />
      <PasswordStep machine={machine} index={startIndex + 1} />
      <InviteStep index={startIndex + 2} onSwitchToJoin={onSwitchToJoin} />
    </>
  );
}
