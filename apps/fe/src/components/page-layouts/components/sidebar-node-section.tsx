// 聚合侧边栏里的「一个 node」分节。
//
// 三种形态（设计 §4「侧边栏聚合视图」）：
//   - 在线且已登录：懒挂该 node 的运行时，渲染真实设备树，每行带 node 徽标；
//   - 在线但未登录：只渲染「登录此节点」按钮，**不**建立连接（避免每次渲染都撞 4401）；
//   - 离线：灰显最近一次已知 inventory 里的设备名，不建连接、不发请求。

import { NodeLoginButton } from '@/auth';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { SELF_NODE_ID, nodeAppPath } from '@tmex/api-client';
import { NodeBadge, type NodeBadgeInfo } from '@tmex/panels/device-tree';
import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { SideBarDeviceListForRuntime } from './sidebar-device-list-runtime';

export interface SidebarNodeEntry {
  /** mesh 列表里的真实 node id。 */
  id: string;
  /** 路由 / 运行时 id：entry 自身为 `self`（保持旧路由）。 */
  runtimeNodeId: string;
  name: string;
  online: boolean;
  loggedIn: boolean;
  isSelf: boolean;
  inventory: unknown;
}

/** 从 inventory 里取最近一次已知的设备列表（离线 node 的灰显数据）。 */
export function inventoryDevices(inventory: unknown): { id: string; name: string }[] {
  if (!inventory || typeof inventory !== 'object') return [];
  const devices = (inventory as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return [];
  const out: { id: string; name: string }[] = [];
  for (const item of devices) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { id?: unknown; name?: unknown };
    if (typeof row.id !== 'string') continue;
    out.push({ id: row.id, name: typeof row.name === 'string' ? row.name : row.id });
  }
  return out;
}

function badgeOf(node: SidebarNodeEntry): NodeBadgeInfo {
  return {
    nodeId: node.runtimeNodeId,
    name: node.name,
    online: node.online,
    isSelf: node.isSelf,
  };
}

function SectionHeader({ node, hint }: { node: SidebarNodeEntry; hint?: string }) {
  return (
    <div
      className="flex items-center gap-2 px-1 pt-1"
      data-testid={`sidebar-node-header-${node.runtimeNodeId}`}
    >
      <NodeBadge info={badgeOf(node)} />
      {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

export function SidebarNodeSection({ node }: { node: SidebarNodeEntry }) {
  const { t } = useTranslation();

  if (!node.online) {
    const devices = inventoryDevices(node.inventory);
    return (
      <div data-testid={`sidebar-node-offline-${node.runtimeNodeId}`} className="space-y-1">
        <SectionHeader node={node} hint={t('sidebar.node.offline')} />
        {devices.length === 0 ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground/60">
            {t('sidebar.node.noKnownDevices')}
          </div>
        ) : (
          devices.map((device) => (
            <Link
              key={device.id}
              to={nodeAppPath(node.runtimeNodeId, `/devices/${encodeURIComponent(device.id)}`)}
              data-testid={`sidebar-node-offline-device-${device.id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground/60"
            >
              <Monitor className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{device.name}</span>
            </Link>
          ))
        )}
      </div>
    );
  }

  if (!node.loggedIn) {
    return (
      <div data-testid={`sidebar-node-login-${node.runtimeNodeId}`} className="space-y-1">
        <SectionHeader node={node} />
        <div className="px-1 pb-1">
          <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} className="w-full" />
        </div>
      </div>
    );
  }

  return (
    <div data-testid={`sidebar-node-${node.runtimeNodeId}`} className="space-y-1">
      <SectionHeader node={node} />
      <NodeRuntimeScope nodeId={node.runtimeNodeId}>
        <SideBarDeviceListForRuntime
          nodeBadge={badgeOf(node)}
          expansionKeyFor={
            node.runtimeNodeId === SELF_NODE_ID
              ? undefined
              : (deviceId) => `${node.runtimeNodeId}:${deviceId}`
          }
          emptyLabel={t('sidebar.node.noDevices')}
        />
      </NodeRuntimeScope>
    </div>
  );
}
