// 步骤 4「生成加入码」与步骤 6「确认加入」。
//
// 创建逻辑与设置页共用 `useCreateEnrollment()`，证书监听与 admit 共用宿主级单例
// `enrollment-engine`（两处 UI 同时开着也只有一条回路、一条 admit 流水线）。
// 这里只负责把 mesh 模式、中继 enrollment 通道与凭据对话框接上，并渲染本次会话那条 pending 的状态。

import { PasskeyTwiceHint } from '@/auth/passkey-twice-hint';
import type { PendingEnrollment } from '@/node/enrollment';
import {
  AdmitOutcome,
  admitFailureText,
  admitStepLabel,
} from '@/pages/settings/nodes/management/admit-rows';
import { Button } from '@vibeterm/ui/button';
import { Input } from '@vibeterm/ui/input';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink } from './guide-step';
import type { JoinEnrollment } from './use-join-enrollment';

export type { JoinSession, JoinSessionIdentity } from './join-session';
export { ADMITTED_SESSION_TTL_MS, isSessionValid } from './join-session';
export type { JoinEnrollment } from './use-join-enrollment';
export { useJoinEnrollment } from './use-join-enrollment';

/** 加入码有效期（分钟）：由 pending 自身的 `createdAt → exp` 反推，不写死。 */
export function joinTokenTtlMinutes(pending: PendingEnrollment): number {
  return Math.max(1, Math.round((pending.exp - pending.createdAt) / 60_000));
}

export function JoinTokenFields({ enrollment }: { enrollment: JoinEnrollment }) {
  const { t } = useTranslation();
  const { create } = enrollment;
  const settingsLink = (
    <GuideLink to="/settings?tab=nodes" testId="connect-join-token-link">
      {t('connectDevices.computer.join.token.link')}
    </GuideLink>
  );

  if (!enrollment.meshEnabled) {
    return (
      <>
        <p className="text-xs text-muted-foreground" data-testid="connect-join-token-unavailable">
          {t('connectDevices.computer.join.token.unavailable')}
        </p>
        {settingsLink}
      </>
    );
  }

  // 中继没给出对外地址就不能编 join 命令：用入口 origin 会把新机器指到没有 uplink
  // 的机器上，redeem 直接 404（与设置页同一条判定）。
  if (!create.publicUrl) {
    return (
      <>
        <p className="text-xs text-destructive" data-testid="connect-join-no-url">
          {t('nodes.enrollment.missingRelayUrl')}
        </p>
        {settingsLink}
      </>
    );
  }

  return (
    <>
      <Input
        placeholder={t('nodes.setup.fields.name')}
        value={create.name}
        data-testid="connect-join-name"
        onChange={(event) => create.setName(event.target.value)}
      />
      {create.error && (
        <p className="text-xs text-destructive" data-testid="connect-join-error">
          {create.error}
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={create.busy || !enrollment.uplinkWritable}
          title={enrollment.uplinkWritable ? undefined : t('nodes.uplinkOffline')}
          onClick={() => void create.submit()}
          data-testid="connect-join-generate"
        >
          {create.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {t('nodes.enrollment.create')}
        </Button>
      </div>
      {create.created && (
        <div className="flex flex-col gap-2" data-testid="connect-join-info">
          <CommandBlock
            value={create.created.joinToken}
            testId="join-token"
            label={t('connectDevices.computer.join.token.label', {
              minutes: joinTokenTtlMinutes(create.created.pending),
            })}
          />
        </div>
      )}
    </>
  );
}

/**
 * 步骤 6「确认加入」：只反映本次会话那条 enrollment。
 *
 * 根钥用户的证书一到就由引擎自动签，用户只会看到「等待新节点加入」→「已加入」；
 * passkey 用户签名必须由手势触发，证书到达后这里给出「确认加入」按钮。
 * 中继模式下加入分两步，进行中的步骤与「成员密钥待补发」由 `AdmitOutcome` 给出，与设置页同一套。
 */
export function JoinConfirmStatus({ enrollment }: { enrollment: JoinEnrollment }) {
  const { t } = useTranslation();
  const { session, engine } = enrollment;
  if (!session) return null;
  const id = session.id;
  const progress = engine.progressById[id];
  const admitted = session.admitted || engine.admittedIds.includes(id);

  // `admit-node` 落账不等于完成：成员密钥还在下发或待补发时不能说「已加入」。
  if (progress && admitted && progress.phase !== 'done') {
    return (
      <AdmitOutcome
        id={id}
        progress={{ ...progress, name: null }}
        doneText={t('connectDevices.computer.join.confirm.done')}
        testId="connect-join-progress"
        onResendKey={enrollment.resendMemberKey}
      />
    );
  }

  // 刷新后引擎的终态投影没了，靠会话里的标记继续显示「已加入」。
  if (admitted) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="connect-join-admitted">
        {t('connectDevices.computer.join.confirm.done')}
      </p>
    );
  }

  const invalidKey = engine.invalidById[id];
  if (invalidKey) {
    return (
      <p className="text-xs text-destructive" data-testid="connect-join-invalid">
        {t(invalidKey)}
      </p>
    );
  }
  return <JoinPendingStatus enrollment={enrollment} id={id} />;
}

function JoinPendingStatus({ enrollment, id }: { enrollment: JoinEnrollment; id: string }) {
  const { t } = useTranslation();
  const { engine } = enrollment;
  // 未确认 = 本机已落账但 `relayAck === false`（`hubAck === false` 同口径；`hubAck` 是冻结 legacy 名）。
  const unconfirmed = engine.unconfirmedIds.includes(id);
  const failureKey = engine.failureById[id];
  const retry = unconfirmed || Boolean(failureKey);
  return (
    <>
      {failureKey ? (
        <p className="text-xs text-destructive" role="alert" data-testid="connect-join-failure">
          {admitFailureText(t, failureKey)}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="connect-join-pending">
          {unconfirmed ? t('nodes.enrollment.relayNotConfirmed') : t('nodes.enrollment.pending')}
        </p>
      )}
      {(retry || engine.certificateReadyIds.includes(id)) && (
        <JoinConfirmAction enrollment={enrollment} id={id} retry={retry} resendOnly={unconfirmed} />
      )}
    </>
  );
}

/**
 * 「确认加入 / 重试」按钮与它旁边的「通行密钥需验证两次」。
 * 中继状态没拉到之前按钮禁用并转圈：还不知道有没有第二步（下发成员密钥）。
 */
function JoinConfirmAction({
  enrollment,
  id,
  retry,
  resendOnly,
}: {
  enrollment: JoinEnrollment;
  id: string;
  retry: boolean;
  /** 上级未确认：只重发已签好的那条，第一次验证早做过了，不再说「两次」。 */
  resendOnly: boolean;
}) {
  const { t } = useTranslation();
  const { engine } = enrollment;
  const busy = engine.busyIds.includes(id);
  const waiting = busy || !enrollment.confirmReady;
  const idleLabel = retry ? t('nodes.enrollment.retry') : t('nodes.enrollment.confirmPending');
  const stepLabel = busy ? admitStepLabel(t, engine.progressById[id]) : null;
  return (
    <>
      <div>
        <Button
          type="button"
          size="sm"
          disabled={waiting}
          onClick={() => enrollment.confirmManually(id)}
          data-testid="connect-join-confirm"
        >
          {waiting ? <Loader2 className="animate-spin" /> : <Check />}
          {stepLabel ?? idleLabel}
        </Button>
      </div>
      {!resendOnly && (
        <PasskeyTwiceHint context={enrollment.passkeyTwice} testId="connect-join-passkey-twice" />
      )}
    </>
  );
}
