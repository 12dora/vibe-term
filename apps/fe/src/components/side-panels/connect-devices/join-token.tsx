// 步骤 4「生成加入码」与步骤 6「确认加入」。
//
// 创建逻辑与设置页共用 `useCreateEnrollment()`，证书监听与 admit 共用宿主级单例
// `enrollment-engine`（两处 UI 同时开着也只有一条回路、一条 admit 流水线）。
// 这里只负责把 mesh 模式、hub 通道与凭据对话框接上，并渲染本次会话那条 pending 的状态。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import type { PendingEnrollment } from '@/node/enrollment';
import {
  type EnrollmentEngineState,
  confirmManually,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { refreshMeshNodes, useHubNode, useSharedAuthMode } from '@/node/mesh-nodes';
import { PLACEHOLDER_KDF, type ResolvedMode } from '@/pages/settings/nodes/management/types';
import {
  type CreateEnrollmentState,
  useCreateEnrollment,
} from '@/pages/settings/nodes/management/use-create-enrollment';
import type { AuthKdfParamsJson, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink } from './guide-step';

/** hub 只靠 `/api/auth/mode` 的 `hubNodeId` 定位，不必把 mesh 列表也拉进侧滑面板。 */
const NO_MESH_NODES: MeshNode[] = [];

/** admit 成功后拉一次成员集：面板自己没有列表，但侧栏与设备页共用这份 store。 */
const refreshAfterAdmit = () => void refreshMeshNodes();

/** 加入码有效期（分钟）：由 pending 自身的 `createdAt → exp` 反推，不写死。 */
export function joinTokenTtlMinutes(pending: PendingEnrollment): number {
  return Math.max(1, Math.round((pending.exp - pending.createdAt) / 60_000));
}

export interface JoinEnrollment {
  /** 本机是否已加入多节点互联；否则不能在此生成加入码。 */
  meshEnabled: boolean;
  /** hub 管理面是否可用（探测成功）。 */
  hubOnline: boolean;
  create: CreateEnrollmentState;
  /** 本次面板会话创建的那条 pending；只跟踪它，不展示全局待确认列表。 */
  pending: PendingEnrollment | null;
  engine: EnrollmentEngineState;
  /** 凭据对话框，必须由调用方挂进 DOM。 */
  dialog: ReactElement | null;
}

export function useJoinEnrollment(): JoinEnrollment {
  const api = defaultAuthApi;
  const { mode: rawMode, meshEnabled } = useSharedAuthMode(api);
  const hub = useHubNode(NO_MESH_NODES, {
    enabled: meshEnabled,
    hubNodeId: rawMode?.hubNodeId ?? null,
  });

  const hasCredentials = Boolean(rawMode?.uid && rawMode?.kdfParams);
  const mode: ResolvedMode | null =
    rawMode && hasCredentials
      ? {
          ...rawMode,
          uid: rawMode.uid as string,
          kdfParams: rawMode.kdfParams as AuthKdfParamsJson,
        }
      : null;

  const { passkeys } = usePasskeys(api, {
    enabled: meshEnabled && hasCredentials && rawMode?.passkeyAvailable === true,
  });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode?.passkeyAvailable ?? false,
  });

  const { t } = useTranslation();
  useEnrollmentEngine({
    api,
    mode,
    hubApi: hub.hubApi,
    prompt,
    onDone: refreshAfterAdmit,
    t,
  });
  const engine = useEnrollmentEngineState();
  const create = useCreateEnrollment({
    api,
    mode,
    hubApi: hub.hubApi,
    prompt,
    clearedIds: engine.clearedIds,
  });

  // join 串会被 `clearedIds` 清掉，但步骤 6 还要接着显示「已加入」，因此单独记住这条 pending。
  const [pending, setPending] = useState<PendingEnrollment | null>(null);
  const created = create.created;
  useEffect(() => {
    if (created) setPending(created.pending);
  }, [created]);
  const dropped =
    pending !== null &&
    (engine.expiredIds.includes(pending.hubEnrollmentId) ||
      engine.cancelledIds.includes(pending.hubEnrollmentId));
  useEffect(() => {
    if (dropped) setPending(null);
  }, [dropped]);

  return {
    meshEnabled,
    hubOnline: hub.online,
    create,
    pending: dropped ? null : pending,
    engine,
    dialog: prompt.dialog,
  };
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

  // hub 没给出对外地址就不能编 join 命令：用入口 origin 会把新机器指到没有 HubRuntime
  // 的机器上，redeem 直接 404（与设置页同一条判定）。
  if (!create.hubUrl) {
    return (
      <>
        <p className="text-xs text-destructive" data-testid="connect-join-no-url">
          {t('nodes.enrollment.missingHubUrl')}
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
          title={enrollment.hubOnline ? undefined : t('nodes.hubOffline')}
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
  const { pending, engine } = enrollment;
  if (!pending) return null;
  const id = pending.hubEnrollmentId;

  if (engine.admittedIds.includes(id)) {
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
  const busy = engine.busyPendingId === id;
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
            onClick={() => void confirmManually(pending)}
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
