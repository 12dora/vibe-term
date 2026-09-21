// 设备管理页里的「一个 node」分组：分组头（把手 / 名称 / 在线态 / 版本）+ 该节点的设备卡片网格。
//
// 三种形态：
//   - 在线且已登录：挂该 node 的运行时，在里面渲染完整的设备管理面板；
//   - 离线：**运行时保持挂载**（ready→offline 翻转不卸载子树，卡片不会消失），面板进 offline
//     模式：不再拉列表，卡片来自 query 缓存 / 本地快照 / 节点 inventory，带「节点离线」标记；
//     连接开关显示「连接」，点了就是一次手动连接尝试（节点仍不通时会走到 error / reconnecting）；
//   - 在线但未登录：先走静默登录门闸（会话钥还在，或能从 IndexedDB 恢复时用户什么都不用点），
//     期间只显示一行「登录中…」；确实登不上才渲染「登录该节点」按钮（凭证类失败再补一行原因）。
//     这一档不建运行时，避免每次渲染都撞 4401。
//   - 在线但**打不通**：静默登录败在传输层（`NODE_UNREACHABLE` / 断网 / 超时）。这不是登录问题，
//     因此既不说「未登录」也不给登录按钮——点了只会在抖动的链路上再叠一次拨号；门闸已经排了
//     退避重试，这里只说「连接不上，稍后自动重试」。
//
// 「添加设备」全页只有顶栏一个 +：ready 的分组把自己的 `openAddDevice` 登记到
// `add-device-targets` 注册表，顶栏据此直接开或先让用户选节点；面板自身仍不监听全局事件
// （多面板同时挂载会一起弹框），只有 entry 自身保留监听兜住其它派发方。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { nodeLoginFailureTextKey } from '@/auth/login-failure-kind';
import { nodeSignInState } from '@/auth/node-signin-state';
import type { LoginFailureCode } from '@/auth/session-key-store';
import { type NodeLoginGate, useNodeLoginGate } from '@/auth/use-node-login';
import { useGlobalDevice } from '@/components/global-device-provider';
import { isMeshNodePaused } from '@/node/merge-nodes';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { MeshNode } from '@vibeterm/api-client/auth/index';
import {
  type AddDevicePreset,
  DeviceCardSkeleton,
  DeviceManagementPanel,
  type DeviceManagementPanelHandle,
  type DeviceNodeContext,
} from '@vibeterm/panels/device-management';
import { NodeBadge } from '@vibeterm/panels/device-tree';
import type { Device } from '@vibeterm/shared';
import { Loader2 } from 'lucide-react';
import { type ReactNode, type Ref, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { registerAddDeviceTarget } from './add-device-targets';
import { offlineDevices, writeDeviceSnapshot } from './device-snapshot-store';

export interface NodeDeviceGroupEntry {
  /** mesh 列表里的真实 node id。 */
  id: string;
  /** 路由 / 运行时 id：entry 自身为 `self`（保持旧路由）。 */
  runtimeNodeId: string;
  name: string;
  online: boolean;
  loggedIn: boolean;
  isSelf: boolean;
  version: string | null;
  inventory: unknown;
  /** 网关说这台的状态块还没解开：名字与设备都还不作数，先画占位。 */
  pending?: boolean;
}

export type NodeDeviceGroupState = 'pending' | 'offline' | 'unreachable' | 'signedOut' | 'ready';

/**
 * 待同步且还打不通时才算 `pending`：链路已经通的那台读到的是真实设备，
 * 不能拿占位把它盖掉。
 *
 * `loginFailure` 是这台 node 最近一次静默登录的失败码：传输层失败落 `unreachable`，
 * 其余（含还没失败过）落 `signedOut`。判定本身收敛在 `nodeSignInState`，与节点管理表同源。
 */
export function nodeDeviceGroupState(
  node: NodeDeviceGroupEntry,
  loginFailure?: LoginFailureCode | null
): NodeDeviceGroupState {
  if (node.pending && !node.online) return 'pending';
  return nodeSignInState({
    online: node.online,
    loggedIn: node.loggedIn,
    failureCode: loginFailure ?? null,
  });
}

/** mesh 节点列表 → 设备页分组：entry 自身排最前，其余按名称排序。 */
export function toNodeDeviceGroups(
  nodes: MeshNode[],
  entryNodeId: string | null,
  pendingIds?: ReadonlySet<string>
): NodeDeviceGroupEntry[] {
  const entries = nodes
    .filter((node) => !isMeshNodePaused(node))
    .map((node) => {
      const isSelf = entryNodeId != null && node.id === entryNodeId;
      return {
        id: node.id,
        runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
        name: node.name,
        online: node.online,
        // self 永远视为已登录：本地 UI 已经过 localUiGuard，再显示登录按钮是死循环。
        loggedIn: isSelf ? true : node.loggedIn,
        isSelf,
        version: node.version ?? null,
        inventory: node.inventory ?? null,
        pending: !isSelf && pendingIds?.has(node.id) === true,
      } satisfies NodeDeviceGroupEntry;
    });
  return entries.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const CHIP_CLASS =
  'rounded border border-border/60 px-1.5 py-px text-[10px] leading-none transition-colors duration-(--vibeterm-motion-fast) ease-out motion-reduce:transition-none';

const STATUS_CHIP_KEYS: Record<NodeDeviceGroupState, string> = {
  pending: 'common.loading',
  offline: 'devices.nodes.status.offline',
  unreachable: 'devices.nodes.status.unreachable',
  signedOut: 'devices.nodes.status.signedOut',
  ready: 'devices.nodes.status.online',
};

function StatusChip({ node, state }: { node: NodeDeviceGroupEntry; state: NodeDeviceGroupState }) {
  const { t } = useTranslation();
  const label = t(STATUS_CHIP_KEYS[state]);
  return (
    <span
      data-testid={`devices-node-status-${node.runtimeNodeId}`}
      data-state={state}
      className={
        state === 'ready'
          ? `${CHIP_CLASS} text-emerald-600 dark:text-emerald-400`
          : `${CHIP_CLASS} text-muted-foreground`
      }
    >
      {label}
    </span>
  );
}

function GroupHeader({
  node,
  state,
  dragControls,
}: {
  node: NodeDeviceGroupEntry;
  state: NodeDeviceGroupState;
  dragControls: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid={`devices-node-header-${node.runtimeNodeId}`}
    >
      {dragControls}
      <NodeBadge
        info={{
          nodeId: node.runtimeNodeId,
          name: node.name,
          online: node.online,
          isSelf: node.isSelf,
        }}
      />
      <StatusChip node={node} state={state} />
      {node.version && (
        <span
          data-testid={`devices-node-version-${node.runtimeNodeId}`}
          title={t('devices.nodes.version', { version: node.version })}
          className="truncate font-mono text-[10px] text-muted-foreground/70"
        >
          {node.version}
        </span>
      )}
    </div>
  );
}

/**
 * 在线但没有该 node 会话时的那一档。
 *
 * 会话钥还在（或能从 IndexedDB 恢复）就由门闸静默登完，用户全程不用点——这正是 PWA 冷启动后
 * 「每台 node 都问一次密码」的修复点。只有门闸判定 `blocked` 才退回按钮。
 *
 * 传输层失败单独一支：不摆登录按钮，只说连接不上并告诉用户会自动重试。
 */
function SignedOutBody({ node, gate }: { node: NodeDeviceGroupEntry; gate: NodeLoginGate }) {
  const { t } = useTranslation();

  if (gate.status === 'pending') {
    return (
      <div
        data-testid={`devices-node-signing-in-${node.runtimeNodeId}`}
        className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
        <span>{t('auth.node.loggingIn')}</span>
      </div>
    );
  }

  const hint = gate.status === 'blocked' ? nodeLoginFailureTextKey(gate.code) : null;
  return (
    <div
      data-testid={`devices-node-login-${node.runtimeNodeId}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
    >
      <p className="text-xs text-muted-foreground">{t('devices.nodes.signInToManage')}</p>
      <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} />
      {hint && (
        <p
          data-testid={`devices-node-login-hint-${node.runtimeNodeId}`}
          className="w-full text-xs text-destructive"
        >
          {t(hint)}
        </p>
      )}
    </div>
  );
}

/** 打不通的那一档：只报状态，不给登录入口——门闸已经排了退避重试。 */
function UnreachableBody({ node }: { node: NodeDeviceGroupEntry }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`devices-node-unreachable-${node.runtimeNodeId}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <span>{t('auth.node.unreachable')}</span>
    </div>
  );
}

export function nodeDeviceContext(
  node: Pick<NodeDeviceGroupEntry, 'runtimeNodeId' | 'name' | 'isSelf'>
): DeviceNodeContext {
  return { runtimeNodeId: node.runtimeNodeId, name: node.name, isSelf: node.isSelf };
}

/**
 * 连接适配器只能在该 node 的 `NodeRuntimeScope` 内部取（scope 里挂着它自己的
 * GlobalDeviceProvider），所以桥接组件必须放在 scope 里面。
 */
function NodeDevicePanel({
  node,
  panelRef,
  offline,
}: {
  node: NodeDeviceGroupEntry;
  panelRef: Ref<DeviceManagementPanelHandle>;
  offline: boolean;
}) {
  const { connection } = useGlobalDevice();
  const { runtimeNodeId, name: nodeName, isSelf: nodeIsSelf } = node;
  // NODE_EVENT 每来一次就换一份 entry 对象，现算的 context 会穿过设备管理面板 → 卡片网格的
  // cardProps，把整页 `memo(SortableDeviceCard)` 全部打穿。按真正读到的三个字段记住即可。
  const nodeContext = useMemo(
    () => nodeDeviceContext({ runtimeNodeId, name: nodeName, isSelf: nodeIsSelf }),
    [runtimeNodeId, nodeName, nodeIsSelf]
  );
  const onDevicesLoaded = useCallback(
    (devices: Device[]) => writeDeviceSnapshot(runtimeNodeId, devices),
    [runtimeNodeId]
  );
  // 只在离线时才去读快照 / inventory；在线时面板用的是真实列表
  const fallbackDevices = useMemo(
    () => (offline ? offlineDevices(runtimeNodeId, node.inventory) : undefined),
    [offline, runtimeNodeId, node.inventory]
  );
  return (
    <DeviceManagementPanel
      ref={panelRef}
      nodeContext={nodeContext}
      connection={connection}
      offline={offline}
      fallbackDevices={fallbackDevices}
      onDevicesLoaded={onDevicesLoaded}
      // entry 自身保留全局事件：外壳右上角的「添加设备」作用于 self。
      listenOpenAddDeviceEvent={node.isSelf}
    />
  );
}

export interface NodeDeviceGroupProps {
  node: NodeDeviceGroupEntry;
  /** standalone 只有一个节点，根层直接显示卡片网格，不要分组头 */
  showHeader?: boolean;
  /** 分组列表给的拖拽把手（与「移出分组」按钮），放在分组头最左 */
  dragControls?: ReactNode;
}

export function NodeDeviceGroup({ node, showHeader = true, dragControls }: NodeDeviceGroupProps) {
  const panelRef = useRef<DeviceManagementPanelHandle>(null);
  const base = nodeDeviceGroupState(node);
  // 门闸只在「在线未登录」那一档开工；其余档位传 enabled:false，一个请求都不发，
  // 但仍然读得到别处（侧边栏、路由门闸）记下的失败，状态标记因此三处一致。
  const gate = useNodeLoginGate(node.runtimeNodeId, { enabled: base === 'signedOut' });
  const state = base === 'signedOut' ? nodeDeviceGroupState(node, gate.code) : base;
  const openAddDevice = useCallback(
    (preset?: AddDevicePreset) => panelRef.current?.openAddDevice(preset),
    []
  );

  // ready 的分组才登记：离线 / 未登录的 node 没有可用面板，顶栏也不该把它列成目标。
  useEffect(() => {
    if (state !== 'ready') return;
    return registerAddDeviceTarget({
      runtimeNodeId: node.runtimeNodeId,
      name: node.name,
      isSelf: node.isSelf,
      open: openAddDevice,
    });
  }, [state, node.runtimeNodeId, node.name, node.isSelf, openAddDevice]);

  return (
    <section
      data-testid={`devices-node-group-${node.runtimeNodeId}`}
      data-state={state}
      className="flex min-w-0 flex-col gap-1.5"
    >
      {/* standalone 根层不要分组头；但进了分组的节点必须有头（把手与「移出分组」都在头上） */}
      {(showHeader || dragControls != null) && (
        <GroupHeader node={node} state={state} dragControls={dragControls ?? null} />
      )}
      {state === 'pending' ? (
        // 状态块还没解开：这台的设备一个都不作数（快照可能是上一代的），先摆卡片占位
        <DeviceCardSkeleton />
      ) : state === 'unreachable' ? (
        <UnreachableBody node={node} />
      ) : state === 'signedOut' ? (
        <SignedOutBody node={node} gate={gate} />
      ) : (
        // ready 与 offline 共用同一棵运行时子树：节点掉线只是把面板切到离线模式，不重挂
        <div
          data-testid={`devices-node-panel-${node.runtimeNodeId}`}
          data-offline={state === 'offline' ? 'true' : undefined}
        >
          <NodeRuntimeScope nodeId={node.runtimeNodeId} offline={state === 'offline'}>
            <NodeDevicePanel node={node} panelRef={panelRef} offline={state === 'offline'} />
          </NodeRuntimeScope>
        </div>
      )}
    </section>
  );
}
