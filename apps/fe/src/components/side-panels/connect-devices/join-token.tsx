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
  admittedNodeIdFor,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { defaultRelayEnrollmentApi } from '@/node/hub-api';
import {
  getMeshNodesState,
  refreshMeshNodes,
  subscribeMeshNodes,
  useHubNode,
  useSharedAuthMode,
} from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import { PLACEHOLDER_KDF, type ResolvedMode } from '@/pages/settings/nodes/management/types';
import {
  type CreateEnrollmentState,
  useCreateEnrollment,
} from '@/pages/settings/nodes/management/use-create-enrollment';
import { useRelayAdmitFollowUp } from '@/pages/settings/nodes/relay/use-relay-admit-follow-up';
import type { AuthKdfParamsJson, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import {
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink } from './guide-step';

/** hub 只靠 `/api/auth/mode` 的 `hubNodeId` 定位，不必把 mesh 列表也拉进侧滑面板。 */
const NO_MESH_NODES: MeshNode[] = [];

/** admit 成功后拉一次成员集：面板自己没有列表，但侧栏与设备页共用这份 store。 */
const refreshAfterAdmit = () => void refreshMeshNodes();

/**
 * 本次面板会话跟踪的那条 enrollment。**全是公开数据，绝不含加入码或私钥**。
 *
 * 落 sessionStorage：面板关掉再开、或整页刷新后，步骤 6 仍要停在正确的状态——
 * pending 本身活在 `enrollment.ts` 的 store 里，丢的只是「哪条是本次会话建的」这层关联，
 * 而「已加入」在 pending 被删之后只剩这个标记能证明（见 R4 #8）。
 *
 * 光存 id 不够：恢复回来的会话必须能证明自己讲的是**同一条 enrollment、同一套身份**，
 * 否则一个 id 相同的新 enrollment、甚至换了账号之后，都会认领这条陈旧的「已加入」
 * （见 R5「恢复的面板会话缺少绑定」）。因此还带 `enrollPk`/`createdAt`（对拍 pending）、
 * `uid`/`hubNodeId`（对拍当前身份）与 `admittedAt`（标记 24 小时后自然过期）。
 */
export interface JoinSession {
  id: string;
  /** base64url 的一次性注册公钥：pending 的唯一身份，公开数据。 */
  enrollPk: string;
  createdAt: number;
  exp: number;
  uid: string | null;
  hubNodeId: string | null;
  admitted: boolean;
  /** 打上「已加入」标记的时刻；未加入为 `null`。 */
  admittedAt: number | null;
  /** admit 那张证书里的新节点 id；重发路径拿不到证书，为 `null`。 */
  nodeId: string | null;
}

/** 「已加入」标记的最长寿命：过了就当作过期信息丢掉，别永远赖在步骤 6 上。 */
export const ADMITTED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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
    if (typeof row.enrollPk !== 'string' || !row.enrollPk) return null;
    return {
      id: row.id,
      enrollPk: row.enrollPk,
      createdAt: numberOr(row.createdAt, 0),
      exp: numberOr(row.exp, 0),
      uid: typeof row.uid === 'string' ? row.uid : null,
      hubNodeId: typeof row.hubNodeId === 'string' ? row.hubNodeId : null,
      admitted: row.admitted === true,
      admittedAt: typeof row.admittedAt === 'number' ? row.admittedAt : null,
      nodeId: typeof row.nodeId === 'string' ? row.nodeId : null,
    };
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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
  /** 上级管理面是否可用：hub 模式看探测结果，中继模式看有没有挂上中继。 */
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

/** 当前这套身份：会话必须与它对得上才作数。 */
export interface JoinSessionIdentity {
  /** `/api/auth/mode` 已经拿到：还没拿到时**什么都不判**，否则刷新瞬间会把会话误清掉。 */
  ready: boolean;
  uid: string | null;
  hubNodeId: string | null;
  /** mesh 成员集里的 node id；`null` 表示列表还没加载出来，此时不做成员对账。 */
  nodeIds: string[] | null;
}

/** 「已加入」标记还算不算数：24 小时内，且（拿得到成员集时）那个节点还在 mesh 里。 */
function isAdmittedMarkerFresh(
  session: JoinSession,
  identity: JoinSessionIdentity,
  now: number
): boolean {
  if (session.admittedAt !== null && now - session.admittedAt > ADMITTED_SESSION_TTL_MS) {
    return false;
  }
  // 节点已被吊销 / 退出 mesh：步骤 6 不该继续说「已加入」。
  if (session.nodeId && identity.nodeIds) return identity.nodeIds.includes(session.nodeId);
  return true;
}

/**
 * 恢复出来的会话是否还该继续显示。
 *
 * 未加入的那条必须在权威 pending store 里找得到**同一条**（id + `enrollPk` + `createdAt`）；
 * 已加入的那条只剩标记可查，于是靠身份绑定 + 24 小时时效 + 成员集对账兜底。
 */
export function isSessionValid(
  session: JoinSession,
  input: {
    identity: JoinSessionIdentity;
    pendings: PendingEnrollment[];
    admittedByEngine: boolean;
    now: number;
  }
): boolean {
  if (session.uid !== input.identity.uid || session.hubNodeId !== input.identity.hubNodeId) {
    return false;
  }
  if (session.admitted || input.admittedByEngine) {
    return isAdmittedMarkerFresh(session, input.identity, input.now);
  }
  return input.pendings.some(
    (row) =>
      row.hubEnrollmentId === session.id &&
      row.enrollPk === session.enrollPk &&
      row.createdAt === session.createdAt
  );
}

function startSession(pending: PendingEnrollment, identity: JoinSessionIdentity): JoinSession {
  return {
    id: pending.hubEnrollmentId,
    enrollPk: pending.enrollPk,
    createdAt: pending.createdAt,
    exp: pending.exp,
    uid: identity.uid,
    hubNodeId: identity.hubNodeId,
    admitted: false,
    admittedAt: null,
    nodeId: null,
  };
}

/**
 * 跟踪本次面板会话那条 enrollment：创建时记下、admit 后打上标记、失效时清掉，
 * 整个过程同步落 sessionStorage，刷新 / 重开面板后步骤 6 仍停在正确的状态。
 */
function useJoinSession(
  created: PendingEnrollment | null,
  engine: EnrollmentEngineState,
  identity: JoinSessionIdentity
): JoinSession | null {
  const pendings = useSyncExternalStore(
    subscribePendingEnrollments,
    listPendingEnrollments,
    listPendingEnrollments
  );
  const [session, setSession] = useState<JoinSession | null>(readJoinSession);
  // 每条新建的 enrollment 只开一次会话：身份刷新（成员集变化）不该把已经清掉的会话复活。
  const startedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!created || startedRef.current === created.hubEnrollmentId) return;
    startedRef.current = created.hubEnrollmentId;
    setSession(writeJoinSession(startSession(created, identity)));
  }, [created, identity]);

  const admittedByEngine = session !== null && engine.admittedIds.includes(session.id);
  const valid =
    identity.ready &&
    session !== null &&
    isSessionValid(session, { identity, pendings, admittedByEngine, now: Date.now() });
  useEffect(() => {
    if (!session || !identity.ready) return;
    if (!valid) {
      setSession(writeJoinSession(null));
      return;
    }
    if (admittedByEngine && !session.admitted) {
      setSession(
        writeJoinSession({
          ...session,
          admitted: true,
          admittedAt: Date.now(),
          nodeId: admittedNodeIdFor(session.id),
        })
      );
    }
  }, [session, valid, admittedByEngine, identity.ready]);

  return valid ? session : null;
}

export function useJoinEnrollment(): JoinEnrollment {
  const api = defaultAuthApi;
  const { mode: rawMode, loaded: modeLoaded, meshEnabled } = useSharedAuthMode(api);
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
  // 中继模式下 enrollment 建在中继上、证书从 `/api/mesh/relay/enrollments/:id` 回读：
  // 中继的 `enroll.redeemed` 没有 `entry_sid`，推不到浏览器，只能靠这条通道轮询。
  const relay = useMeshRelay();
  const enrollChannel = relay.relayMode ? defaultRelayEnrollmentApi : hub.hubApi;
  const { confirmManually } = useEnrollmentEngine({
    api,
    mode,
    hubApi: enrollChannel,
    prompt,
    onDone: refreshAfterAdmit,
    t,
  });
  const engine = useEnrollmentEngineState();
  // admit 之后补发当前世代的 K_meta；宿主级去重，设置页同时开着也只会补一次。
  useRelayAdmitFollowUp({
    enabled: relay.relayMode,
    admittedIds: engine.admittedIds,
    api,
    mode,
  });
  const create = useCreateEnrollment({
    api,
    mode,
    hubApi: enrollChannel,
    prompt,
    clearedIds: engine.clearedIds,
  });

  const meshState = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  // 只读共享 store 的快照，不额外拉一次 `/api/mesh/nodes`：拿不到就退回纯时效判定。
  const identity = useMemo<JoinSessionIdentity>(
    () => ({
      ready: modeLoaded && rawMode !== null,
      uid: rawMode?.uid ?? null,
      hubNodeId: rawMode?.hubNodeId ?? null,
      nodeIds: meshState.loadedAt === null ? null : meshState.nodes.map((node) => node.id),
    }),
    [modeLoaded, rawMode, meshState.loadedAt, meshState.nodes]
  );
  const session = useJoinSession(create.created?.pending ?? null, engine, identity);

  return {
    meshEnabled,
    hubOnline: relay.relayMode ? relay.writable : hub.online,
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
