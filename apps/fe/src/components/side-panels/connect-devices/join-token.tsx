// 步骤 4「生成加入码」与步骤 6「确认加入」。
//
// 创建逻辑与设置页共用 `useCreateEnrollment()`，证书监听与 admit 共用宿主级单例
// `enrollment-engine`（两处 UI 同时开着也只有一条回路、一条 admit 流水线）。
// 这里只负责把 mesh 模式、hub 通道与凭据对话框接上，并渲染本次会话那条 pending 的状态。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import {
  type PendingEnrollment,
  listPendingEnrollments,
  subscribePendingEnrollments,
} from '@/node/enrollment';
import {
  type EnrollmentEngineState,
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
import { type ReactElement, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink } from './guide-step';

/** hub 只靠 `/api/auth/mode` 的 `hubNodeId` 定位，不必把 mesh 列表也拉进侧滑面板。 */
const NO_MESH_NODES: MeshNode[] = [];

/** admit 成功后拉一次成员集：面板自己没有列表，但侧栏与设备页共用这份 store。 */
const refreshAfterAdmit = () => void refreshMeshNodes();

/**
 * 本次面板会话跟踪的那条 enrollment（**只有 id 与是否已加入，绝不含加入码或私钥**）。
 *
 * 落 sessionStorage：面板关掉再开、或整页刷新后，步骤 6 仍要停在正确的状态——
 * pending 本身活在 `enrollment.ts` 的 store 里，丢的只是「哪条是本次会话建的」这层关联，
 * 而「已加入」在 pending 被删之后只剩这个标记能证明（见 R4 #8）。
 */
export interface JoinSession {
  id: string;
  admitted: boolean;
}

const SESSION_STORAGE_KEY = 'tmex.connectDevices.joinSession';

function sessionStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
}

function readJoinSession(): JoinSession | null {
  try {
    const raw = sessionStore()?.getItem(SESSION_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) return null;
    return { id: row.id, admitted: row.admitted === true };
  } catch {
    return null;
  }
}

function writeJoinSession(session: JoinSession | null): JoinSession | null {
  try {
    const store = sessionStore();
    if (!store) return session;
    if (session) store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // 隐私模式下 sessionStorage 会抛；内存态仍然有效，刷新后丢失即可。
  }
  return session;
}

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
  /** 本次面板会话创建的那条 enrollment；只跟踪它，不展示全局待确认列表。 */
  session: JoinSession | null;
  engine: EnrollmentEngineState;
  /** 步骤 6 的「确认加入」：绑定本面板这个引擎槽位。 */
  confirmManually: (enrollmentId: string) => void;
  /** 凭据对话框，必须由调用方挂进 DOM。 */
  dialog: ReactElement | null;
}

/** 本次会话那条 enrollment 是否已经走完：过期、取消，或刷新回来时它早已不在 pending store 里。 */
function isSessionGone(
  id: string,
  engine: EnrollmentEngineState,
  pendings: PendingEnrollment[]
): boolean {
  if (engine.expiredIds.includes(id) || engine.cancelledIds.includes(id)) return true;
  return !pendings.some((row) => row.hubEnrollmentId === id);
}

/**
 * 跟踪本次面板会话那条 enrollment：创建时记下、admit 后打上标记、终态时清掉，
 * 整个过程同步落 sessionStorage，刷新 / 重开面板后步骤 6 仍停在正确的状态。
 */
function useJoinSession(createdId: string | null, engine: EnrollmentEngineState) {
  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );
  const [session, setSession] = useState<JoinSession | null>(readJoinSession);
  useEffect(() => {
    if (createdId) setSession(writeJoinSession({ id: createdId, admitted: false }));
  }, [createdId]);

  const id = session?.id ?? null;
  const admitted = id !== null && (session?.admitted === true || engine.admittedIds.includes(id));
  const gone = id !== null && !admitted && isSessionGone(id, engine, pendings);
  useEffect(() => {
    if (id === null) return;
    if (gone) setSession(writeJoinSession(null));
    else if (admitted) {
      setSession((row) => (row?.admitted ? row : writeJoinSession({ id, admitted: true })));
    }
  }, [id, gone, admitted]);

  return gone ? null : session;
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
  const { confirmManually } = useEnrollmentEngine({
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

  const session = useJoinSession(create.created?.pending.hubEnrollmentId ?? null, engine);

  return {
    meshEnabled,
    hubOnline: hub.online,
    create,
    session,
    engine,
    confirmManually: (enrollmentId: string) => void confirmManually(enrollmentId),
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
