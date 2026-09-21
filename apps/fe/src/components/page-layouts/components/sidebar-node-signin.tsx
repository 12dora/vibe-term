// 在线但还没有该 node 会话：默认折叠，用户点开（或冷启动自动登一次）才触发静默登录。

import { restoreSessionKey } from '@/auth/session-key-store';
import { useNodeLoginGate } from '@/auth/use-node-login';
import { useUIStore } from '@vibeterm/stores/react';
import { cn } from '@vibeterm/ui';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { SectionHeader } from './sidebar-node-header';
import {
  type SidebarNodeEntry,
  type SidebarNodeSortable,
  hasSidebarVisibleDeviceForNode,
  selectedDeviceIdForNode,
} from './sidebar-node-model';
import { SidebarNodeSignInBody } from './sidebar-node-signin-body';
import { useSectionPresence } from './use-section-presence';

/**
 * 已经自动登过一次的 node（每次页面加载一份）。
 *
 * 会话 18 小时到期后重开 PWA，每个远端 node 都会退回「登录此节点」按钮——但内存 / IndexedDB
 * 里的会话钥往往还在，用户要做的只是点一下。这里替他点：**只点一次**，失败就老实退回按钮，
 * 否则一串 401 会变成一轮又一轮的静默登录。用户手动点开时不受这条记账约束。
 */
const eagerSignInAttempted = new Set<string>();

/** 领一次自动登录的名额；同一个 node 每次页面加载只发一次。 */
export function claimEagerSignIn(runtimeNodeId: string): boolean {
  if (eagerSignInAttempted.has(runtimeNodeId)) return false;
  eagerSignInAttempted.add(runtimeNodeId);
  return true;
}

/** 仅测试使用：清掉「已自动登过」的记账。 */
export function resetEagerSignInForTest(): void {
  eagerSignInAttempted.clear();
}

function useEagerNodeSignIn(runtimeNodeId: string, present: boolean): boolean {
  const [eager, setEager] = useState(false);
  useEffect(() => {
    if (!present || eager || eagerSignInAttempted.has(runtimeNodeId)) return;
    let cancelled = false;
    // 冷启动时会话钥还在 IndexedDB 里（内存是空的），`restoreSessionKey()` 是那条恢复入口；
    // 恢复不出来就别自动登，直接把「登录此节点」按钮留给用户。
    void restoreSessionKey().then((info) => {
      if (cancelled || !info || !claimEagerSignIn(runtimeNodeId)) return;
      setEager(true);
    });
    return () => {
      cancelled = true;
    };
  }, [present, eager, runtimeNodeId]);
  return eager;
}

/**
 * 在线但还没有该 node 会话：默认折叠，一个请求都不发。用户点开才触发静默登录
 * （`useNodeLoginGate` 用内存里的会话钥），登录期间显示转圈，失败退回「登录此节点」按钮
 * ——会话钥已经没了的话那个按钮会带 `?node=` 去登录页。
 *
 * 一台设备都没开侧边栏显示的 node 整节不出现：登录进去也只剩一个空标题，那条登录入口反而
 * 像是「登完就消失」。开启过设备的 node 才留这条紧凑行，供用户重新登录回来；正在浏览该 node
 * 某台设备时同样保留，否则页面上就没有登录入口可点了。
 */
export function SidebarNodeSignIn({
  node,
  drag,
}: {
  node: SidebarNodeEntry;
  drag?: SidebarNodeSortable;
}) {
  const [expanded, setExpanded] = useState(false);
  const visibility = useUIStore((state) => state.sidebarDeviceVisibility);
  const selectedDeviceId = selectedDeviceIdForNode(useLocation().pathname, node.runtimeNodeId);
  const present =
    selectedDeviceId !== null || hasSidebarVisibleDeviceForNode(visibility, node.runtimeNodeId);
  const eager = useEagerNodeSignIn(node.runtimeNodeId, present);
  const gate = useNodeLoginGate(node.runtimeNodeId, { enabled: expanded || eager });
  const presence = useSectionPresence(present, null);
  if (!presence.rendered) return null;

  return (
    <div
      ref={drag?.sortable.setNodeRef}
      style={drag?.sortable.style}
      data-testid={`sidebar-node-login-${node.runtimeNodeId}`}
      className={cn('space-y-0.5', presence.className, drag?.sortable.isDragging && 'opacity-60')}
    >
      <SectionHeader node={node} drag={drag} />
      <div className="px-1 pb-0.5">
        <SidebarNodeSignInBody
          node={node}
          gate={gate}
          expanded={expanded}
          eager={eager}
          onExpand={() => setExpanded(true)}
        />
      </div>
    </div>
  );
}
