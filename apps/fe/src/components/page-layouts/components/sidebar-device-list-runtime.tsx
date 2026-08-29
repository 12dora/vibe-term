// 单个 node 运行时下的设备树（原 `sidebar-device-list.tsx` 的全部内容）。
// 聚合视图给每个在线且已登录的 node 各挂一份；standalone / 单 node 宿主直接用它。

import { useGlobalDevice } from '@/components/global-device-provider';
import {
  SideBarDeviceList as DeviceTreeSideBarDeviceList,
  shouldHideSidebarNodeSection,
  useSidebarDeviceStats,
} from '@tmex/panels/device-tree';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import type { CSSProperties, ReactNode } from 'react';
import { SidebarAgentSessionsProvider, useSidebarAgentAdapter } from './sidebar-agent-sessions';

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
}: Omit<SideBarDeviceListForRuntimeProps, 'section'>) {
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
    />
  );

  // agentUi 关断时设备树不渲染任何 agent 面，provider 一并跳过（省掉会话列表 bootstrap）
  if (!agentUi) return tree;
  return <SidebarAgentSessionsProvider>{tree}</SidebarAgentSessionsProvider>;
}

/**
 * 分节形态。可见性判断必须留在**挂了该 node 运行时**的组件里：设备列表是运行时作用域内的
 * react-query（分节头在作用域外读不到），而且隐藏时本组件只是 return null、查询照样活着，
 * 用户在「管理设备」里勾上一台，这一节会自己回来。
 */
function NodeSection({
  section,
  ...rest
}: SideBarDeviceListForRuntimeProps & { section: SidebarNodeSectionShell }) {
  const stats = useSidebarDeviceStats();
  if (!stats.failed && shouldHideSidebarNodeSection(stats, section.keepWhenNoDevices ?? false)) {
    return null;
  }

  return (
    <div
      ref={section.containerRef}
      style={section.containerStyle}
      data-testid={section.testId}
      className={cn('space-y-0.5', section.containerClassName)}
    >
      {section.header}
      <DeviceTree {...rest} />
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
