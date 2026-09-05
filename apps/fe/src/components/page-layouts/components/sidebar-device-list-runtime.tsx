// 单个 node 运行时下的设备树（原 `sidebar-device-list.tsx` 的全部内容）。
// 聚合视图给每个在线且已登录的 node 各挂一份；standalone / 单 node 宿主直接用它。

import { useGlobalDevice } from '@/components/global-device-provider';
import {
  SideBarDeviceList as DeviceTreeSideBarDeviceList,
  type SidebarDeviceStatsResult,
  shouldHideSidebarNodeSection,
  useSidebarDeviceStats,
} from '@tmex/panels/device-tree';
import type { Device } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Skeleton } from '@tmex/ui/skeleton';
import { Monitor } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect } from 'react';
import { SidebarAgentSessionsProvider, useSidebarAgentAdapter } from './sidebar-agent-sessions';
import { useSectionPresence } from './use-section-presence';

/** 聚合视图的分节外壳：分节头与设备树同生共死，没有可显示的设备时整节都不渲染。 */
export interface SidebarNodeSectionShell {
  testId: string;
  header: ReactNode;
  /** 该 node 一台设备都没有时是否仍渲染（本机保留空态引导，远端直接隐藏） */
  keepWhenNoDevices?: boolean;
  /**
   * 分节根元素的拖拽接线。分节可能整节隐藏（return null），所以 sortable 的
   * ref/transform 只能挂在这个真正的根元素上，不能由调用方在外面套一层空壳。
   */
  containerRef?: (element: HTMLElement | null) => void;
  containerStyle?: CSSProperties;
  containerClassName?: string;
  /**
   * 首帧占位设备（本地快照 / node inventory）。`/api/devices` 还没落地时先按它渲染设备行，
   * 没有快照就只出一条紧凑骨架——但分节头（节点名 / 在线态 / 徽标）一律立刻出现。
   */
  placeholderDevices?: Device[];
  /** 真实设备列表落地时回调（宿主据此刷新本地快照）。 */
  onDevicesLoaded?: (devices: Device[]) => void;
}

export interface SideBarDeviceListForRuntimeProps {
  /** 多 node 下把 UI store 的展开态按 node 隔离；self 传 undefined 保持旧 key。 */
  expansionKeyFor?: (deviceId: string) => string;
  emptyLabel?: string;
  /** 传了就渲染成聚合视图的一节；不传就是单 node 宿主的裸设备树。 */
  section?: SidebarNodeSectionShell;
}

function DeviceTree({
  expansionKeyFor,
  emptyLabel,
  pinnedDeviceIds,
}: Omit<SideBarDeviceListForRuntimeProps, 'section'> & { pinnedDeviceIds?: readonly string[] }) {
  const { ensureDeviceSubscribed, connection } = useGlobalDevice();
  const agentUi = useRuntime().features.agentUi;
  const agentAdapter = useSidebarAgentAdapter();

  const tree = (
    <DeviceTreeSideBarDeviceList
      ensureDeviceSubscribed={ensureDeviceSubscribed}
      connection={connection}
      agent={agentUi ? agentAdapter : undefined}
      expansionKeyFor={expansionKeyFor}
      emptyLabel={emptyLabel}
      pinnedDeviceIds={pinnedDeviceIds}
    />
  );

  // agentUi 关断时设备树不渲染任何 agent 面，provider 一并跳过（省掉会话列表 bootstrap）
  if (!agentUi) return tree;
  return <SidebarAgentSessionsProvider>{tree}</SidebarAgentSessionsProvider>;
}

/**
 * `/api/devices` 未落地时的设备行占位。有本地快照就直接把上次的设备名灰显出来
 * （不做链接：这一刻该 node 的运行时还没接上，点进去只会等在空页面上），
 * 一台都不知道时给两条骨架，让用户看到「这里正在加载」而不是「这个节点没有设备」。
 */
export function PendingDeviceRows({
  nodeId,
  devices,
}: { nodeId: string; devices: readonly Device[] }) {
  if (devices.length === 0) {
    return (
      <div className="space-y-1 px-2 py-1" data-testid={`sidebar-node-skeleton-${nodeId}`}>
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    );
  }
  return (
    <div data-testid={`sidebar-node-placeholder-${nodeId}`}>
      {devices.map((device) => (
        <div
          key={device.id}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground/60"
        >
          <Monitor className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{device.name}</span>
        </div>
      ))}
    </div>
  );
}

export function pendingRows(stats: {
  devices: readonly Device[];
  visibleIds: readonly string[];
}): Device[] {
  const visible = new Set(stats.visibleIds);
  return stats.devices.filter((device) => visible.has(device.id));
}

/**
 * 分节整体是否渲染。`pending`（`/api/devices` 还没落地）与 `failed` 都算可见：
 * 那一刻的「零设备」不是事实，按它把节点名与在线徽标一起藏掉，正是冷启动后
 * 节点半天不出现的直接成因。
 *
 * 可见性判断必须留在**挂了该 node 运行时**的组件里：设备列表是运行时作用域内的
 * react-query（分节头在作用域外读不到），而且隐藏时本组件只是 return null、查询照样活着，
 * 用户在「管理设备」里勾上一台，这一节会自己回来。
 */
export function isNodeSectionVisible(
  stats: SidebarDeviceStatsResult,
  keepWhenNoDevices: boolean
): boolean {
  return stats.failed || !shouldHideSidebarNodeSection(stats, keepWhenNoDevices);
}

/**
 * 真实列表落地后把它交回宿主（写本地快照）。只认**成功**的返回：占位数据不回传，
 * 失败态同样不回传——那一刻的空数组不是事实，写进快照会把上次成功的设备名冲掉，
 * 之后离线首屏与 inventory 兜底都拿不到东西。成功返回的空列表照常保存。
 */
function useDevicesLoaded(
  devices: Device[],
  succeeded: boolean,
  onDevicesLoaded?: (devices: Device[]) => void
): void {
  useEffect(() => {
    if (!succeeded || !onDevicesLoaded) return;
    onDevicesLoaded(devices);
  }, [devices, succeeded, onDevicesLoaded]);
}

function NodeSection({
  section,
  ...rest
}: SideBarDeviceListForRuntimeProps & { section: SidebarNodeSectionShell }) {
  const { nodeId } = useRuntime();
  const stats = useSidebarDeviceStats({ placeholderDevices: section.placeholderDevices });
  useDevicesLoaded(stats.devices, stats.succeeded, section.onDevicesLoaded);
  const visible = isNodeSectionVisible(stats, section.keepWhenNoDevices ?? false);
  // 切 node 会让「选中的那台无条件保留」失效，整节可能就此隐藏：淡出后再卸载，别硬切；
  // 退场期间把上一帧的可见设备集合钉住，否则设备行先消失、只剩分节头在淡
  const presence = useSectionPresence(visible, stats.visibleIds);
  if (!presence.rendered) {
    return null;
  }

  const pending = stats.pending === true;
  return (
    <div
      ref={section.containerRef}
      style={section.containerStyle}
      data-testid={section.testId}
      data-pending={pending ? 'true' : undefined}
      className={cn('space-y-0.5', presence.className, section.containerClassName)}
    >
      {section.header}
      {pending ? (
        <PendingDeviceRows nodeId={nodeId} devices={pendingRows(stats)} />
      ) : (
        <DeviceTree {...rest} pinnedDeviceIds={visible ? undefined : presence.value} />
      )}
    </div>
  );
}

export function SideBarDeviceListForRuntime({
  section,
  ...rest
}: SideBarDeviceListForRuntimeProps) {
  if (!section) return <DeviceTree {...rest} />;
  return <NodeSection section={section} {...rest} />;
}
