// 「本机自建中继」子路径：本机设为中继 → 设置接入密码 → 接入本机中继 → 让新机器加入。
// 前三步的现状来自 `/api/local/status`（角色与 relay.hasPassword）与中继链路，拿不到时一律按待办渲染。
//
// 第三步不能省：租户编号是本机接入这条中继之后才有的，没有它，新机器拿到的 relay join 命令
// 只能是带占位符的半成品。

import { Button } from '@tmex/ui/button';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { isRelayRole } from './connect-path';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { relayEnrollCommand } from './join-command-preview';
import type { ConnectMachine } from './use-connect-machine';

const PREFIX = 'connectDevices.computer.relayHost';

/** 一级选择占第 1 步，本机自建的步骤从 2 开始。 */
export const RELAY_HOST_STEP_OFFSET = 2;

/** 本机已经作为租户接进自己那条中继：租户编号到手，才谈得上让别的机器加入。 */
export function relayHostEnrolled(machine: ConnectMachine): boolean {
  return machine.relayMode && machine.tenantId !== null;
}

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
        <GuideNote testId="connect-relay-setup-requirement">
          {t(`${PREFIX}.setup.requirement`)}
        </GuideNote>
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

/** 本机以租户身份接进自己那条中继：设置页的「接入本机中继」，或终端里的 relay enroll。 */
function EnrollStep({ machine, index }: { machine: ConnectMachine; index: number }) {
  const { t } = useTranslation();
  if (relayHostEnrolled(machine)) {
    return (
      <GuideStep
        index={index}
        state="done"
        testId="connect-step-relay-enroll"
        title={t(`${PREFIX}.enroll.title`)}
      >
        <CommandBlock
          value={machine.tenantId as string}
          testId="relay-tenant-id"
          label={t(`${PREFIX}.enroll.tenantId`)}
        />
      </GuideStep>
    );
  }
  return (
    <GuideStep
      index={index}
      testId="connect-step-relay-enroll"
      title={t(`${PREFIX}.enroll.title`)}
      description={t(`${PREFIX}.enroll.description`)}
    >
      <GuideLink to="/settings?tab=nodes" testId="connect-relay-enroll-link">
        {t(`${PREFIX}.enroll.link`)}
      </GuideLink>
      <CommandBlock
        value={relayEnrollCommand(machine.relayPublicUrl)}
        testId="relay-enroll"
        label={t(`${PREFIX}.enroll.command`)}
      />
    </GuideStep>
  );
}

function InviteStep({
  ready,
  index,
  onSwitchToJoin,
}: {
  ready: boolean;
  index: number;
  onSwitchToJoin: () => void;
}) {
  const { t } = useTranslation();
  return (
    <GuideStep
      index={index}
      testId="connect-step-relay-invite"
      title={t(`${PREFIX}.invite.title`)}
      description={t(ready ? `${PREFIX}.invite.description` : `${PREFIX}.invite.blocked`)}
    >
      {ready && (
        <Button
          size="xs"
          variant="outline"
          data-testid="connect-relay-goto-join"
          onClick={onSwitchToJoin}
        >
          {t(`${PREFIX}.invite.gotoJoin`)}
        </Button>
      )}
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
      <EnrollStep machine={machine} index={startIndex + 2} />
      <InviteStep
        ready={relayHostEnrolled(machine)}
        index={startIndex + 3}
        onSwitchToJoin={onSwitchToJoin}
      />
    </>
  );
}
