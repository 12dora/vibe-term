// 设备管理页里的「一个 node」分组：分组头（把手 / 名称 / 在线态 / Hub / 版本）+ 该节点的设备卡片网格。
//
// 三种形态：
//   - 在线且已登录：挂该 node 的运行时，在里面渲染完整的设备管理面板；
//   - 离线：**运行时保持挂载**（ready→offline 翻转不卸载子树，卡片不会消失），面板进 offline
//     模式：不再拉列表，卡片来自 query 缓存 / 本地快照 / 节点 inventory，带「节点离线」标记；
//     连接开关显示「连接」，点了就是一次手动连接尝试（节点仍不通时会走到 error / reconnecting）；
//   - 在线但未登录：只渲染「登录此节点」按钮，不建运行时（避免每次渲染都撞 4401）。
//
// 「添加设备」全页只有顶栏一个 +：ready 的分组把自己的 `openAddDevice` 登记到
// `add-device-targets` 注册表，顶栏据此直接开或先让用户选节点；面板自身仍不监听全局事件
// （多面板同时挂载会一起弹框），只有 entry 自身保留监听兜住其它派发方。

import { NodeLoginButton } from '@/auth';
import { useGlobalDevice } from '@/components/global-device-provider';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import {
  DeviceManagementPanel,
  type DeviceManagementPanelHandle,
  type DeviceNodeContext,
} from '@tmex/panels/device-management';
import { NodeBadge } from '@tmex/panels/device-tree';
import type { Device } from '@tmex/shared';
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
  isHub: boolean;
  version: string | null;
  inventory: unknown;
}

export type NodeDeviceGroupState = 'offline' | 'signedOut' | 'ready';

export function nodeDeviceGroupState(node: NodeDeviceGroupEntry): NodeDeviceGroupState {
  if (!node.online) return 'offline';
  if (!node.loggedIn) return 'signedOut';
  return 'ready';
}

/** mesh 节点列表 → 设备页分组：entry 自身排最前，其余按名称排序。 */
export function toNodeDeviceGroups(
  nodes: MeshNode[],
  entryNodeId: string | null
): NodeDeviceGroupEntry[] {
  const entries = nodes.map((node) => {
    const isSelf = entryNodeId != null && node.id === entryNodeId;
    return {
      id: node.id,
      runtimeNodeId: isSelf ? SELF_NODE_ID : node.id,
      name: node.name,
      online: node.online,
      // self 永远视为已登录：本地 UI 已经过 localUiGuard，再显示登录按钮是死循环。
      loggedIn: isSelf ? true : node.loggedIn,
      isSelf,
      isHub: node.isHub === true,
      version: node.version ?? null,
      inventory: node.inventory ?? null,
    } satisfies NodeDeviceGroupEntry;
  });
  return entries.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

const CHIP_CLASS =
  'rounded border border-border/60 px-1.5 py-px text-[10px] leading-none transition-colors duration-(--tmex-motion-fast) ease-out motion-reduce:transition-none';

function StatusChip({ node }: { node: NodeDeviceGroupEntry }) {
  const { t } = useTranslation();
  const state = nodeDeviceGroupState(node);
  const label =
    state === 'offline'
      ? t('devices.nodes.status.offline')
      : state === 'signedOut'
        ? t('devices.nodes.status.signedOut')
        : t('devices.nodes.status.online');
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
  dragControls,
}: {
  node: NodeDeviceGroupEntry;
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
      <StatusChip node={node} />
      {node.isHub && (
        <span
          data-testid={`devices-node-hub-${node.runtimeNodeId}`}
          className={`${CHIP_CLASS} text-muted-foreground`}
        >
          {t('devices.nodes.status.hub')}
        </span>
      )}
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

function SignedOutBody({ node }: { node: NodeDeviceGroupEntry }) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`devices-node-login-${node.runtimeNodeId}`}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
    >
      <p className="text-xs text-muted-foreground">{t('devices.nodes.signInToManage')}</p>
      <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} />
    </div>
  );
}

export function nodeDeviceContext(node: NodeDeviceGroupEntry): DeviceNodeContext {
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
  const runtimeNodeId = node.runtimeNodeId;
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
      nodeContext={nodeDeviceContext(node)}
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
  const state = nodeDeviceGroupState(node);
  const openAddDevice = useCallback(() => panelRef.current?.openAddDevice(), []);

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
        <GroupHeader node={node} dragControls={dragControls ?? null} />
      )}
      {state === 'signedOut' ? (
        <SignedOutBody node={node} />
      ) : (
        // ready 与 offline 共用同一棵运行时子树：节点掉线只是把面板切到离线模式，不重挂
        <div
          data-testid={`devices-node-panel-${node.runtimeNodeId}`}
          data-offline={state === 'offline' ? 'true' : undefined}
        >
          <NodeRuntimeScope nodeId={node.runtimeNodeId}>
            <NodeDevicePanel node={node} panelRef={panelRef} offline={state === 'offline'} />
          </NodeRuntimeScope>
        </div>
      )}
    </section>
  );
}
