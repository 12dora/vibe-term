// 「让新机器加入」分支：默认路径是账号密码（新机器上填地址 + 密码，或一条 CLI 命令），
// 加入码收进折叠的「高级」区——它需要在本机先生成一次，且 10 分钟就过期。
//
// 填什么取决于本机自己接的是谁：Hub 模式给 Hub 地址，中继模式给中继地址与租户编号。

import { joinCommand } from '@/node/enrollment';
import { useSharedAuthMode } from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import type { AuthModeResponse } from '@tmex/api-client/auth/index';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink, GuideNote, GuideStep } from './guide-step';
import { joinCommandPreview, passwordJoinCommand, relayJoinCommand } from './join-command-preview';
import { JoinConfirmStatus, JoinTokenFields, useJoinEnrollment } from './join-token';

const PREFIX = 'connectDevices.computer.join';
/** 安装、选择接入方式两步固定在前，分支步骤从 3 开始。 */
export const BRANCH_STEP_OFFSET = 3;

/** 新机器该往哪儿加入：本机接 Hub 就给 Hub 地址，接中继就给中继地址 + 租户编号。 */
export interface JoinUplink {
  kind: 'hub' | 'relay' | 'unknown';
  url: string | null;
  tenantId: string | null;
}

export function resolveJoinUplink(input: {
  mode: AuthModeResponse | null;
  relayMode: boolean;
  relayUrl: string | null;
  tenantId: string | null;
}): JoinUplink {
  if (input.mode?.mode !== 'mesh') return { kind: 'unknown', url: null, tenantId: null };
  if (input.relayMode) {
    return { kind: 'relay', url: input.relayUrl, tenantId: input.tenantId };
  }
  return { kind: 'hub', url: input.mode.hubPublicUrl ?? null, tenantId: null };
}

function UplinkStep({ uplink }: { uplink: JoinUplink }) {
  const { t } = useTranslation();
  const link = (
    <GuideLink to="/settings?tab=nodes" testId="connect-join-uplink-link">
      {t(`${PREFIX}.token.link`)}
    </GuideLink>
  );
  if (uplink.kind === 'unknown') {
    return (
      <GuideStep
        index={BRANCH_STEP_OFFSET}
        testId="connect-step-join-uplink"
        title={t(`${PREFIX}.uplink.title`)}
        description={t(`${PREFIX}.uplink.unknownDescription`)}
      >
        {link}
      </GuideStep>
    );
  }
  const relay = uplink.kind === 'relay';
  return (
    <GuideStep
      index={BRANCH_STEP_OFFSET}
      state={uplink.url ? 'done' : 'todo'}
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
        <GuideNote tone="warning" testId="connect-join-uplink-missing">
          {t(`${PREFIX}.uplink.missingUrl`)}
        </GuideNote>
      )}
      {relay && uplink.tenantId && (
        <CommandBlock
          value={uplink.tenantId}
          testId="join-tenant-id"
          label={t(`${PREFIX}.uplink.tenantId`)}
        />
      )}
      {link}
    </GuideStep>
  );
}

function PasswordStep({ uplink }: { uplink: JoinUplink }) {
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
      index={BRANCH_STEP_OFFSET + 1}
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

/** 加入码：不再是默认路径，收进折叠区，编号从 1 重新起，与上面两步分开读。 */
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

export function JoinSteps() {
  const { mode } = useSharedAuthMode();
  const relay = useMeshRelay({ enabled: mode?.mode === 'mesh' });
  const enrollment = useJoinEnrollment();
  const uplink = resolveJoinUplink({
    mode,
    relayMode: relay.relayMode,
    relayUrl: (relay.attached ?? relay.ordered[0])?.url ?? null,
    tenantId: relay.tenantId,
  });

  return (
    <>
      <UplinkStep uplink={uplink} />
      <PasswordStep uplink={uplink} />
      <TokenAdvanced enrollment={enrollment} />
      {enrollment.dialog}
    </>
  );
}
