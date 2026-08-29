// 聚合侧边栏里的「一个 node」分节。
//
// 三种形态（设计 §4「侧边栏聚合视图」）：
//   - 在线且已登录：懒挂该 node 的运行时，渲染真实设备树，每行带 node 徽标；
//   - 在线但未登录：折叠，只给一个「登录」入口，**不**自动登录也**不**建立连接；
//     用户点开才用内存里的会话钥静默登录，登不上再退回「登录此节点」按钮；
//   - 离线：灰显最近一次已知 inventory 里的设备名，不建连接、不发请求。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { loginErrorKey } from '@/auth/login-errors';
import { useNodeLoginGate } from '@/auth/use-node-login';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { SELF_NODE_ID, nodeAppPath, parseNodeIdFromPath } from '@tmex/api-client';
import {
  NodeBadge,
  type NodeBadgeInfo,
  shouldHideSidebarNodeSection,
} from '@tmex/panels/device-tree';
import { isSidebarDeviceVisible } from '@tmex/stores';
import { useUIStore } from '@tmex/stores/react';
import { ChevronRight, Loader2, Monitor } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, matchPath, useLocation } from 'react-router';
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

/**
 * 当前路由选中的那台设备（限定在给定 node 下）。
 *
 * 在线分节的可见性过滤（`selectSidebarVisibleDevices`）对选中的设备无条件放行；离线分节
 * 读不到 runtime、也没有那个 selector，只能自己从地址栏解析——否则一台默认隐藏的远端设备
 * 在被选中期间只要它的 node 掉线，就会从侧边栏里凭空消失。
 */
export function selectedDeviceIdForNode(pathname: string, runtimeNodeId: string): string | null {
  if (parseNodeIdFromPath(pathname) !== runtimeNodeId) return null;
  const match = matchPath(
    { path: nodeAppPath(runtimeNodeId, '/devices/:deviceId'), end: false },
    pathname
  );
  const raw = match?.params.deviceId;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
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

/**
 * 在线但还没有该 node 会话：默认折叠，一个请求都不发。用户点开才触发静默登录
 * （`useNodeLoginGate` 用内存里的会话钥），登录期间显示转圈，失败退回「登录此节点」按钮
 * ——会话钥已经没了的话那个按钮会带 `?node=` 去登录页。
 */
function SidebarNodeSignIn({ node }: { node: SidebarNodeEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const gate = useNodeLoginGate(node.runtimeNodeId, { enabled: expanded });

  return (
    <div data-testid={`sidebar-node-login-${node.runtimeNodeId}`} className="space-y-1">
      <SectionHeader node={node} />
      <div className="px-1 pb-1">
        {!expanded ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-(--tmex-motion-fast) ease-out hover:bg-sidebar-accent hover:text-foreground motion-reduce:transition-none"
            data-testid={`sidebar-node-expand-${node.runtimeNodeId}`}
            onClick={() => setExpanded(true)}
          >
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{t('auth.node.loginToThisNode')}</span>
          </button>
        ) : gate.status === 'pending' ? (
          <div
            className="tmex-fade flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
            data-testid={`sidebar-node-pending-${node.runtimeNodeId}`}
          >
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            <span className="truncate">{t('auth.node.loggingIn')}</span>
          </div>
        ) : (
          <div className="tmex-fade flex flex-col gap-1">
            {gate.code ? (
              <span
                className="px-1 text-[10px] text-destructive"
                data-testid={`sidebar-node-error-${node.runtimeNodeId}`}
              >
                {t(loginErrorKey(gate.code, 'password'))}
              </span>
            ) : null}
            <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} className="w-full" />
          </div>
        )}
      </div>
    </div>
  );
}

export function SidebarNodeSection({ node }: { node: SidebarNodeEntry }) {
  const { t } = useTranslation();
  // UI store 是宿主级共享实例（所有 node 同一份），离线分节没有自己的 runtime 也读得到。
  const visibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const selectedDeviceId = selectedDeviceIdForNode(useLocation().pathname, node.runtimeNodeId);

  if (!node.online) {
    const knownDevices = inventoryDevices(node.inventory);
    const devices = knownDevices.filter(
      (device) =>
        device.id === selectedDeviceId ||
        isSidebarDeviceVisible(visibility, node.runtimeNodeId, device.id)
    );
    // 已知设备全被取消显示时整节隐藏（与在线分节同一条规则）；一台已知设备都没有的
    // 离线 node 仍留个分节头，否则用户完全看不出它存在过。
    if (shouldHideSidebarNodeSection({ total: knownDevices.length, visible: devices.length }, true))
      return null;

    return (
      <div data-testid={`sidebar-node-offline-${node.runtimeNodeId}`} className="space-y-1">
        <SectionHeader node={node} hint={t('sidebar.node.offline')} />
        {knownDevices.length === 0 ? (
          <div className="tmex-fade px-2 py-1 text-[11px] text-muted-foreground/60">
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
    return <SidebarNodeSignIn node={node} />;
  }

  // 分节头交给设备树一起渲染：可见设备数只有挂上该 node 运行时才读得到，
  // 一台都不显示时整节（含分节头）都不该出现。
  return (
    <NodeRuntimeScope nodeId={node.runtimeNodeId}>
      <SideBarDeviceListForRuntime
        section={{
          testId: `sidebar-node-${node.runtimeNodeId}`,
          header: <SectionHeader node={node} />,
          keepWhenNoDevices: node.isSelf,
        }}
        expansionKeyFor={
          node.runtimeNodeId === SELF_NODE_ID
            ? undefined
            : (deviceId) => `${node.runtimeNodeId}:${deviceId}`
        }
        emptyLabel={t('sidebar.node.noDevices')}
      />
    </NodeRuntimeScope>
  );
}
