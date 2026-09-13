// 步骤 4「生成加入码」与步骤 6「确认加入」。
//
// 创建逻辑与设置页共用 `useCreateEnrollment()`，证书监听与 admit 共用宿主级单例
// `enrollment-engine`（两处 UI 同时开着也只有一条回路、一条 admit 流水线）。
// 这里只负责把 mesh 模式、hub 通道与凭据对话框接上，并渲染本次会话那条 pending 的状态。

import type { PendingEnrollment } from '@/node/enrollment';
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

  // 上级没给出对外地址就不能编 join 命令：用入口 origin 会把新机器指到没有 HubRuntime
  // 的机器上，redeem 直接 404（与设置页同一条判定）。中继模式下缺的是中继地址。
  if (!create.hubUrl) {
    return (
      <>
        <p className="text-xs text-destructive" data-testid="connect-join-no-url">
          {t(
            create.relayMode ? 'nodes.enrollment.missingRelayUrl' : 'nodes.enrollment.missingHubUrl'
          )}
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
          disabled={create.busy || !enrollment.hubOnline}
          title={enrollment.hubOnline ? undefined : t('nodes.uplinkOffline')}
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
 * 步骤 6「确认加入」：只反映本次会话那条 pending。
 *
 * 根钥用户的证书一到就由引擎自动签，用户只会看到「等待新节点加入」→「已加入」；
 * passkey 用户签名必须由手势触发，证书到达后这里给出「确认加入」按钮。
 */
export function JoinConfirmStatus({ enrollment }: { enrollment: JoinEnrollment }) {
  const { t } = useTranslation();
  const { session, engine } = enrollment;
  if (!session) return null;
  const id = session.id;

  // 刷新后引擎的终态投影没了，靠会话里的标记继续显示「已加入」。
  if (session.admitted || engine.admittedIds.includes(id)) {
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

  const unconfirmed = engine.hubUnconfirmedIds.includes(id);
  const busy = engine.busyIds.includes(id);
  // hub 未确认时手上还留着一份可重发的记录，同样要给按钮。
  const confirmable = unconfirmed || engine.certificateReadyIds.includes(id);
  return (
    <>
      <p className="text-xs text-muted-foreground" data-testid="connect-join-pending">
        {unconfirmed ? t('nodes.enrollment.hubNotConfirmed') : t('nodes.enrollment.pending')}
      </p>
      {confirmable && (
        <div>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => enrollment.confirmManually(id)}
            data-testid="connect-join-confirm"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            {unconfirmed ? t('nodes.enrollment.retryHub') : t('nodes.enrollment.confirmPending')}
          </Button>
        </div>
      )}
    </>
  );
}
