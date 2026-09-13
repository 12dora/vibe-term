// 加入码面板的 enrollment 接线：mesh 模式、hub 通道、凭据对话框与本次会话。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import {
  type EnrollmentEngineState,
  useEnrollmentEngine,
  useEnrollmentEngineState,
} from '@/node/enrollment-engine';
import { defaultRelayEnrollmentApi } from '@/node/hub-api';
import {
  ensureFreshMeshNodes,
  getMeshNodesState,
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
import { RelayMetaLagNotice } from '@/pages/settings/nodes/relay/relay-meta-lag-notice';
import { useRelayAdmitFollowUp } from '@/pages/settings/nodes/relay/use-relay-admit-follow-up';
import type {
  AuthKdfParamsJson,
  AuthModeResponse,
  MeshNode,
} from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { type ReactElement, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { type JoinSession, type JoinSessionIdentity, useJoinSession } from './join-session';

/** hub 只靠 `/api/auth/mode` 的 `hubNodeId` 定位，不必把 mesh 列表也拉进侧滑面板。 */
const NO_MESH_NODES: MeshNode[] = [];

/**
 * admit 成功后拉一次成员集：面板自己没有列表，但侧栏与设备页共用这份 store。
 * 走 `ensureFreshMeshNodes`：admit 之前发出的那次请求即便还在飞，也拿不到刚加入的成员。
 */
const refreshAfterAdmit = () => ensureFreshMeshNodes();

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
  /** 「成员密钥未送达」告警条（服务端真相）；没有欠账时为 `null`。 */
  metaLagNotice: ReactElement | null;
}

function toResolvedMode(
  rawMode: AuthModeResponse | null,
  hasCredentials: boolean
): ResolvedMode | null {
  if (!rawMode || !hasCredentials) return null;
  return {
    ...rawMode,
    uid: rawMode.uid as string,
    kdfParams: rawMode.kdfParams as AuthKdfParamsJson,
  };
}

function useJoinAuthContext() {
  const api = defaultAuthApi;
  const { mode: rawMode, loaded: modeLoaded, meshEnabled } = useSharedAuthMode(api);
  const hub = useHubNode(NO_MESH_NODES, {
    enabled: meshEnabled,
    hubNodeId: rawMode?.hubNodeId ?? null,
  });
  const hasCredentials = Boolean(rawMode?.uid && rawMode?.kdfParams);
  const mode = toResolvedMode(rawMode, hasCredentials);
  const { passkeys } = usePasskeys(api, {
    enabled: meshEnabled && hasCredentials && rawMode?.passkeyAvailable === true,
  });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode?.passkeyAvailable ?? false,
  });
  return { api, rawMode, modeLoaded, meshEnabled, hub, mode, prompt };
}

function useJoinSessionIdentity(
  modeLoaded: boolean,
  rawMode: AuthModeResponse | null
): JoinSessionIdentity {
  const meshState = useSyncExternalStore(subscribeMeshNodes, getMeshNodesState, getMeshNodesState);
  return useMemo<JoinSessionIdentity>(
    () => ({
      ready: modeLoaded && rawMode !== null,
      uid: rawMode?.uid ?? null,
      hubNodeId: rawMode?.hubNodeId ?? null,
      nodeIds: meshState.loadedAt === null ? null : meshState.nodes.map((node) => node.id),
    }),
    [modeLoaded, rawMode, meshState.loadedAt, meshState.nodes]
  );
}

function metaLagNoticeOf(
  relay: ReturnType<typeof useMeshRelay>,
  ctx: ReturnType<typeof useJoinAuthContext>
): ReactElement | null {
  if (!relay.relayMode || relay.metaKeyLagging.length === 0) return null;
  return (
    <RelayMetaLagNotice
      lagging={relay.metaKeyLagging}
      mode={ctx.mode}
      api={ctx.api}
      prompt={ctx.prompt}
      onChanged={refreshAfterAdmit}
    />
  );
}

export function useJoinEnrollment(): JoinEnrollment {
  const ctx = useJoinAuthContext();
  const { t } = useTranslation();
  // 中继模式下 enrollment 建在中继上、证书从 `/api/mesh/relay/enrollments/:id` 回读：
  // 中继的 `enroll.redeemed` 没有 `entry_sid`，推不到浏览器，只能靠这条通道轮询。
  // standalone 下这族路由是全局 401：只在 mesh 里才问，否则 session 拦截器会把页面踢去登录页。
  const relay = useMeshRelay({ enabled: ctx.meshEnabled });
  const enrollChannel = relay.relayMode ? defaultRelayEnrollmentApi : ctx.hub.hubApi;
  const { confirmManually } = useEnrollmentEngine({
    api: ctx.api,
    mode: ctx.mode,
    hubApi: enrollChannel,
    prompt: ctx.prompt,
    onDone: refreshAfterAdmit,
    t,
  });
  const engine = useEnrollmentEngineState();
  // admit 之后补发当前世代的 K_meta；宿主级去重，设置页同时开着也只会补一次。
  useRelayAdmitFollowUp({
    enabled: relay.relayMode,
    admittedIds: engine.admittedIds,
    api: ctx.api,
    mode: ctx.mode,
  });
  const create = useCreateEnrollment({
    api: ctx.api,
    mode: ctx.mode,
    hubApi: enrollChannel,
    prompt: ctx.prompt,
    clearedIds: engine.clearedIds,
    relay,
  });

  // 只读共享 store 的快照，不额外拉一次 `/api/mesh/nodes`：拿不到就退回纯时效判定。
  const identity = useJoinSessionIdentity(ctx.modeLoaded, ctx.rawMode);
  const session = useJoinSession(create.created?.pending ?? null, engine, identity);

  return {
    meshEnabled: ctx.meshEnabled,
    hubOnline: relay.relayMode ? relay.writable : ctx.hub.online,
    create,
    session,
    engine,
    confirmManually: (enrollmentId: string) => void confirmManually(enrollmentId),
    dialog: ctx.prompt.dialog,
    // 这条面板正是「加一台机器」的入口：刚批准的那台没拿到成员密钥，必须在这里就说清楚，
    // 而不是等用户下次翻到设置页（见 relay-meta-lag-notice.tsx）。
    metaLagNotice: metaLagNoticeOf(relay, ctx),
  };
}
