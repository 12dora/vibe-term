// 「加入已有中继 / 加入已有 Hub」两条子路径共用的步骤：准备接入信息 → 在新机器上加入，
// 加入码收进折叠的「高级」区——它需要在本机先签发一次，且 10 分钟就过期。
//
// 摆什么由用户选的路径决定：中继给中继地址 + 租户编号，Hub 给 Hub 地址。

import { joinCommand } from '@/node/enrollment';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { isRelayRole } from './connect-path';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { joinCommandPreview, passwordJoinCommand, relayJoinCommand } from './join-command-preview';
import { JoinConfirmStatus, JoinTokenFields, useJoinEnrollment } from './join-token';
import type { ConnectMachine } from './use-connect-machine';

const PREFIX = 'connectDevices.computer.join';

/** 一级选择固定占第 1 步，安装占第 2 步，加入步骤从 3 开始。 */
export const JOIN_STEP_OFFSET = 3;

export type JoinVariant = 'relay' | 'hub';

/** 新机器该往哪儿加入：中继给地址 + 租户编号，Hub 只给地址。 */
export interface JoinUplink {
  kind: JoinVariant;
  url: string | null;
  tenantId: string | null;
  /** 本机既没加入 mesh 也不是中继：地址得先把本机自己配好才有。 */
  standalone: boolean;
}

export function resolveJoinUplink(variant: JoinVariant, machine: ConnectMachine): JoinUplink {
  const standalone = !machine.meshEnabled && !isRelayRole(machine.role);
  if (variant === 'relay') {
    return { kind: 'relay', url: machine.relayUrl, tenantId: machine.tenantId, standalone };
  }
  return { kind: 'hub', url: machine.hubUrl, tenantId: null, standalone };
}

function UplinkMissing({ uplink }: { uplink: JoinUplink }) {
  const { t } = useTranslation();
  return (
    <>
      <GuideNote tone="warning" testId="connect-join-uplink-missing">
        {t(
          uplink.kind === 'relay' ? `${PREFIX}.uplink.relayMissing` : `${PREFIX}.uplink.hubMissing`
        )}
      </GuideNote>
      {uplink.standalone && (
        <GuideLink to="/settings?tab=nodes" testId="connect-join-uplink-link">
          {t(`${PREFIX}.uplink.link`)}
        </GuideLink>
      )}
    </>
  );
}

/** 中继路径要地址和租户编号齐了才算备齐：`tmex relay join` 两个都是必填。 */
export function uplinkReady(uplink: JoinUplink): boolean {
  return uplink.url !== null && (uplink.kind === 'hub' || uplink.tenantId !== null);
}

function UplinkStep({ uplink, index }: { uplink: JoinUplink; index: number }) {
  const { t } = useTranslation();
  const relay = uplink.kind === 'relay';
  return (
    <GuideStep
      index={index}
      state={uplinkReady(uplink) ? 'done' : 'todo'}
      testId="connect-step-join-uplink"
      title={t(`${PREFIX}.uplink.title`)}
      description={t(
        relay ? `${PREFIX}.uplink.relayDescription` : `${PREFIX}.uplink.hubDescription`
      )}
    >
      {uplink.url ? (
        <CommandBlock
          value={uplink.url}
          testId="join-uplink-url"
          label={t(relay ? `${PREFIX}.uplink.relayUrl` : `${PREFIX}.uplink.hubUrl`)}
        />
      ) : (
        <UplinkMissing uplink={uplink} />
      )}
      {relay &&
        uplink.url &&
        (uplink.tenantId ? (
          <CommandBlock
            value={uplink.tenantId}
            testId="join-tenant-id"
            label={t(`${PREFIX}.uplink.tenantId`)}
          />
        ) : (
          <GuideNote testId="connect-join-tenant-missing">
            {t(`${PREFIX}.uplink.tenantMissing`)}
          </GuideNote>
        ))}
    </GuideStep>
  );
}

function PasswordStep({ uplink, index }: { uplink: JoinUplink; index: number }) {
  const { t } = useTranslation();
  const relay = uplink.kind === 'relay';
  const command = relay
    ? relayJoinCommand({
        relayUrl: uplink.url,
        tenantId: uplink.tenantId,
        tenantPlaceholder: t(`${PREFIX}.password.tenantPlaceholder`),
      })
    : passwordJoinCommand(uplink.url);
  return (
    <GuideStep
      index={index}
      testId="connect-step-join-password"
      title={t(`${PREFIX}.password.title`)}
      description={t(
        relay ? `${PREFIX}.password.relayDescription` : `${PREFIX}.password.hubDescription`
      )}
    >
      <CommandBlock
        value={command}
        testId="join-password"
        label={t(`${PREFIX}.password.command`)}
      />
    </GuideStep>
  );
}

/** 加入码：不是默认路径，收进折叠区，编号从 1 重新起，与上面两步分开读。 */
function TokenAdvanced({ enrollment }: { enrollment: ReturnType<typeof useJoinEnrollment> }) {
  const { t } = useTranslation();
  const { create } = enrollment;
  const ready = create.created !== null && create.hubUrl !== null;
  const command =
    create.created && create.hubUrl
      ? joinCommand(create.hubUrl, create.created.joinToken, create.created.pending.name)
      : joinCommandPreview({
          hubPublicUrl: create.hubUrl,
          name: create.name,
          tokenPlaceholder: t(`${PREFIX}.run.tokenPlaceholder`),
          namePlaceholder: t(`${PREFIX}.run.namePlaceholder`),
        });
  return (
    <details
      className="rounded-xl bg-card p-3 ring-1 ring-foreground/10"
      data-testid="connect-join-token-advanced"
    >
      <summary className="cursor-pointer text-sm font-medium">
        {t(`${PREFIX}.advanced.title`)}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-xs text-muted-foreground">{t(`${PREFIX}.advanced.description`)}</p>
        <GuideStep
          index={1}
          testId="connect-step-join-token"
          title={t(`${PREFIX}.token.title`)}
          description={t(
            enrollment.meshEnabled
              ? `${PREFIX}.token.meshDescription`
              : `${PREFIX}.token.description`
          )}
        >
          <JoinTokenFields enrollment={enrollment} />
        </GuideStep>
        <GuideStep
          index={2}
          testId="connect-step-join-run"
          title={t(`${PREFIX}.run.title`)}
          description={t(ready ? `${PREFIX}.run.ready` : `${PREFIX}.run.description`)}
        >
          <CommandBlock value={command} testId="join" />
        </GuideStep>
        <GuideStep
          index={3}
          testId="connect-step-join-confirm"
          title={t(`${PREFIX}.confirm.title`)}
          description={t(
            enrollment.meshEnabled
              ? `${PREFIX}.confirm.meshDescription`
              : `${PREFIX}.confirm.description`
          )}
        >
          <JoinConfirmStatus enrollment={enrollment} />
        </GuideStep>
      </div>
    </details>
  );
}

/**
 * 加入码只能由本机当前的上级签发：签发通道认的是本机真实的 uplink 模式，
 * 与所选路径对不上时签出来的凭据指向另一条链路，这块整个不出现。
 */
export function canIssueJoinToken(variant: JoinVariant, machine: ConnectMachine): boolean {
  return variant === 'relay' ? machine.relayMode : !machine.relayMode;
}

export function JoinSteps({
  variant,
  machine,
  startIndex = JOIN_STEP_OFFSET,
}: {
  variant: JoinVariant;
  machine: ConnectMachine;
  startIndex?: number;
}) {
  const enrollment = useJoinEnrollment();
  const uplink = resolveJoinUplink(variant, machine);

  return (
    <>
      <UplinkStep uplink={uplink} index={startIndex} />
      <PasswordStep uplink={uplink} index={startIndex + 1} />
      {canIssueJoinToken(variant, machine) && <TokenAdvanced enrollment={enrollment} />}
      {enrollment.dialog}
    </>
  );
}
