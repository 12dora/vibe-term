// 设备管理页里的「一个 node」分组。三种形态与侧边栏聚合视图一致：
//   - 离线：灰显最近一次已知 inventory 里的设备名，不建连接、不发请求；
//   - 在线但未登录：只渲染「登录此节点」按钮，不建连接（避免每次渲染都撞 4401）；
//   - 在线且已登录：懒挂该 node 的运行时，在里面渲染完整的设备管理面板。
//
// 「添加设备」全页只有顶栏一个 +：ready 的分组把自己的 `openAddDevice` 登记到
// `add-device-targets` 注册表，顶栏据此直接开或先让用户选节点；面板自身仍不监听全局事件
// （多面板同时挂载会一起弹框），只有 entry 自身保留监听兜住其它派发方。

import { NodeLoginButton } from '@/auth';
import { inventoryDevices } from '@/components/page-layouts/components/sidebar-node-section';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { SELF_NODE_ID } from '@tmex/api-client';
import type { MeshNode } from '@tmex/api-client/auth/index';
import {
  DeviceManagementPanel,
  type DeviceManagementPanelHandle,
} from '@tmex/panels/device-management';
import { NodeBadge } from '@tmex/panels/device-tree';
import { Monitor } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { registerAddDeviceTarget } from './add-device-targets';

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

function GroupHeader({ node }: { node: NodeDeviceGroupEntry }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid={`devices-node-header-${node.runtimeNodeId}`}
    >
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

function OfflineBody({ node }: { node: NodeDeviceGroupEntry }) {
  const { t } = useTranslation();
  const devices = inventoryDevices(node.inventory);
  return (
    <div
      data-testid={`devices-node-offline-${node.runtimeNodeId}`}
      className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
    >
      {devices.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">{t('devices.nodes.noKnownDevices')}</p>
      ) : (
        <>
          <p className="pb-1.5 text-[11px] text-muted-foreground/60">
            {t('devices.nodes.lastKnownDevices')}
          </p>
          <ul className="space-y-1">
            {devices.map((device) => (
              <li
                key={device.id}
                data-testid={`devices-node-offline-device-${device.id}`}
                className="flex items-center gap-2 text-xs text-muted-foreground/60"
              >
                <Monitor className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{device.name}</span>
              </li>
            ))}
          </ul>
        </>
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

export function NodeDeviceGroup({ node }: { node: NodeDeviceGroupEntry }) {
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
      className="flex flex-col gap-1.5"
    >
      <GroupHeader node={node} />
      {state === 'offline' && <OfflineBody node={node} />}
      {state === 'signedOut' && <SignedOutBody node={node} />}
      {state === 'ready' && (
        <div data-testid={`devices-node-panel-${node.runtimeNodeId}`}>
          <NodeRuntimeScope nodeId={node.runtimeNodeId}>
            <DeviceManagementPanel
              ref={panelRef}
              // entry 自身保留全局事件：外壳右上角的「添加设备」作用于 self。
              listenOpenAddDeviceEvent={node.isSelf}
              className="max-w-none gap-2 p-0 pb-0 sm:gap-2 sm:p-0"
            />
          </NodeRuntimeScope>
        </div>
      )}
    </section>
  );
}
