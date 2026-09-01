import { Bot, CirclePlus, FolderClosed, Monitor, PanelsTopLeft } from 'lucide-react';
import { type ComponentProps, Suspense, lazy, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { SIDE_PANEL_LINK_STATE, useSidePanel } from '@/components/side-panels/use-side-panel';
import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { useNodeOffline } from '@/node/node-offline';
import { useRouteNodeId } from '@/node/node-runtime-boundary';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import { nodeQueryClient } from '@/node/node-runtimes';
import { selfAgentStore } from '@/node/self-agent-store';
import { sidebarSectionExpanded, useSidebarSectionExpanded } from '@/node/sidebar-node-expansion';
import { SELF_NODE_ID } from '@tmex/api-client';
import { SortableVerticalList, useSortableRow } from '@tmex/panels/device-tree';
import type { FilesNodeInfo } from '@tmex/panels/files';
import { SettingsEventsInit } from '@tmex/panels/settings/events';
import { useUIStore } from '@tmex/stores/react';
import { Reveal } from '@tmex/ui/motion';
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader } from '@tmex/ui/sidebar';
import { Tabs, TabsList, TabsTrigger, pillTabTriggerClassName } from '@tmex/ui/tabs';
import { NavMain, type NavMainItem } from './nav-main';
import {
  SideBarDeviceList,
  sidebarNodeIdFromSortableId,
  sidebarNodeSortableId,
  toSidebarEntries,
} from './sidebar-device-list';
import type { SidebarNodeEntry } from './sidebar-node-section';
import { SidebarTitle } from './sidebar-title';

// AgentTab / FilesTab 仅在选中对应 tab 时才渲染，改 React.lazy 懒加载，
// 把 agent / files 两个子系统（含各自 store + 重组件链）移出首屏 entry chunk。
const AgentTab = lazy(() => import('@tmex/panels/agent').then((m) => ({ default: m.AgentTab })));
const FilesTab = lazy(() => import('@tmex/panels/files').then((m) => ({ default: m.FilesTab })));
const FilesNodeSection = lazy(() =>
  import('@tmex/panels/files').then((m) => ({ default: m.FilesNodeSection }))
);

const FILES_QUERY_KEY = ['files'];

function filesNodeInfo(entry: SidebarNodeEntry): FilesNodeInfo {
  return {
    id: entry.id,
    runtimeNodeId: entry.runtimeNodeId,
    name: entry.name,
    online: entry.online,
    loggedIn: entry.loggedIn,
    isSelf: entry.isSelf,
  };
}

/** 未登录的远端 node：只给一个登录入口，点了才用内存里的会话钥登录（不自动发请求）。 */
function renderNodeLogin(node: FilesNodeInfo) {
  return <NodeLoginButton nodeId={node.runtimeNodeId} nodeName={node.name} className="w-full" />;
}

/** 该分节能挂运行时（在线且已登录）。 */
function isFilesSectionMounted(entry: SidebarNodeEntry): boolean {
  return entry.online && entry.loggedIn;
}

/** 此刻确实挂着运行时：还要求分节没被折叠——只有这些 node 有自己的 QueryClient 与事件订阅。 */
function hasMountedFilesRuntime(
  entry: SidebarNodeEntry,
  expansion: Record<string, boolean>
): boolean {
  return (
    isFilesSectionMounted(entry) &&
    (sidebarSectionExpanded(expansion, 'files', entry.runtimeNodeId) ?? true)
  );
}

function SortableFilesNodeSection({ entry }: { entry: SidebarNodeEntry }) {
  const { t } = useTranslation();
  const sortable = useSortableRow(sidebarNodeSortableId(entry.id));
  const drag = { sortable, dragHandleLabel: t('sidebar.node.dragHandle') };
  const node = filesNodeInfo(entry);
  // 文件栏的分节缺省展开（用户切到这个标签就是要看文件），折叠后连运行时一起摘掉：
  // 收起的远端 node 不该继续占着一条 WS 与直连协商。
  const [expanded, setExpanded] = useSidebarSectionExpanded('files', node.runtimeNodeId, true);

  // 离线 / 未登录 / 已折叠的 node 不挂运行时：不建连接，也不发它的 files 查询。
  if (!isFilesSectionMounted(entry) || !expanded) {
    return (
      <FilesNodeSection
        node={node}
        drag={drag}
        renderLogin={renderNodeLogin}
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
    );
  }
  return (
    <NodeRuntimeScope nodeId={node.runtimeNodeId}>
      {/* 远端分节的 SETTINGS_UPDATE 订阅只能挂在这里：main.tsx 的两处只覆盖 self 与路由 node，
          没有它，别处改了该 node 的目录配置，本页这份缓存要等手动刷新/窗口聚焦才更新。
          self 恒由 main.tsx 覆盖，不重复订阅。 */}
      {node.runtimeNodeId !== SELF_NODE_ID && <SettingsEventsInit />}
      <FilesNodeSection
        node={node}
        drag={drag}
        expanded={expanded}
        onExpandedChange={setExpanded}
      />
    </NodeRuntimeScope>
  );
}

/**
 * mesh 下的文件侧栏：每个 node 一个分节（顺序与终端侧栏共用 `sidebarNodeOrder`）。
 * 外壳挂在 entry 运行时下，各分节各自套自己的运行时 + QueryClient，刷新只能逐个失效。
 */
function MeshFilesTab({ entryNodeId }: { entryNodeId: string | null }) {
  const { nodes } = useMeshNodes({ enabled: false });
  const sidebarNodeOrder = useUIStore((state) => state.sidebarNodeOrder);
  const setSidebarNodeOrder = useUIStore((state) => state.setSidebarNodeOrder);
  const expansion = useUIStore((state) => state.sidebarNodeExpansion);

  const entries = useMemo(
    () => toSidebarEntries(nodes, entryNodeId, sidebarNodeOrder),
    [nodes, entryNodeId, sidebarNodeOrder]
  );
  const sortableIds = useMemo(
    () => entries.map((entry) => sidebarNodeSortableId(entry.id)),
    [entries]
  );
  const handleReorder = useCallback(
    (nextIds: string[]) => setSidebarNodeOrder(nextIds.map(sidebarNodeIdFromSortableId)),
    [setSidebarNodeOrder]
  );
  // 只失效**已挂载**分节的缓存：`nodeQueryClient()` 是懒建 + 登记的，对离线/未登录的 node
  // 调它会留下一份永远等不到 `onDispose` 的缓存。
  const refresh = useCallback(() => {
    for (const entry of entries) {
      if (!hasMountedFilesRuntime(entry, expansion)) continue;
      void nodeQueryClient(entry.runtimeNodeId).invalidateQueries({ queryKey: FILES_QUERY_KEY });
    }
  }, [entries, expansion]);

  // mesh 列表还没回来时先渲染 self 的文件树，避免侧边栏首屏闪空。
  if (entries.length === 0) return <FilesTab />;

  return (
    <FilesTab
      onRefresh={refresh}
      sections={
        <SortableVerticalList ids={sortableIds} onReorder={handleReorder}>
          {entries.map((entry) => (
            <SortableFilesNodeSection key={entry.runtimeNodeId} entry={entry} />
          ))}
        </SortableVerticalList>
      }
    />
  );
}

/** standalone / 单 node 下就是今天的单运行时文件树（零新增请求、无分节头）。 */
function SidebarFilesTab({
  routeNodeId,
  routeNodeOffline,
}: { routeNodeId: string; routeNodeOffline: boolean | undefined }) {
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  if (!meshEnabled) {
    return (
      <NodeRuntimeScope nodeId={routeNodeId}>
        <FilesTab nodeOffline={routeNodeOffline} />
      </NodeRuntimeScope>
    );
  }
  return <MeshFilesTab entryNodeId={entryNodeId} />;
}

const manageDevicesItem: NavMainItem = {
  title: 'nav.manageDevices',
  url: '/devices',
  icon: Monitor,
};

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const sidebarTab = useUIStore((state) => state.sidebarTab);
  const setSidebarTab = useUIStore((state) => state.setSidebarTab);
  // 外壳常驻在 self 运行时下；智能体 / 文件两个标签服务的是当前路由所在的 node，
  // 单独套一层该 node 的运行时（切 node 时这两块重挂是预期的，设备树不受影响）
  const routeNodeId = useRouteNodeId();
  const routeNodeOffline = useNodeOffline(routeNodeId);
  // 「接入更多设备」是右侧滑出面板：入口保持链接形态（可右键新开、可分享）。
  const { hrefFor } = useSidePanel();
  const footerItems: NavMainItem[] = [
    {
      title: 'nav.connectDevices',
      shortTitle: 'nav.connectDevicesShort',
      url: hrefFor('connect'),
      icon: CirclePlus,
      testId: 'sidebar-connect-devices',
      linkState: SIDE_PANEL_LINK_STATE,
    },
    manageDevicesItem,
  ];

  return (
    <Sidebar variant="inset" {...props}>
      <div className="h-[var(--tmex-safe-area-top)]" />
      <SidebarHeader className="gap-4 pt-3 pb-0">
        <SidebarTitle />
        {/* 上移 5px（gap 20→16 再 -1px）：让 TabsList 里可见的 active 药丸上沿与右侧
            终端卡片的可见上沿齐平——药丸比 TabsList 外框低 border 1px + p-1 4px。 */}
        <Tabs
          className="-mt-px mb-2.5"
          value={sidebarTab}
          onValueChange={(value) => setSidebarTab(value as typeof sidebarTab)}
        >
          <TabsList className="w-full p-1 rounded-xl border border-border/60 group-data-horizontal/tabs:h-11">
            <TabsTrigger
              value="panes"
              data-testid="sidebar-tab-panes"
              className={pillTabTriggerClassName}
            >
              <PanelsTopLeft />
              {t('sidebar.tab.panes')}
            </TabsTrigger>
            <TabsTrigger
              value="agent"
              data-testid="sidebar-tab-agent"
              className={pillTabTriggerClassName}
            >
              <Bot />
              {t('sidebar.tab.agent')}
            </TabsTrigger>
            <TabsTrigger
              value="files"
              data-testid="sidebar-tab-files"
              className={pillTabTriggerClassName}
            >
              <FolderClosed />
              {t('sidebar.tab.files')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </SidebarHeader>
      <SidebarContent className="flex min-h-0 flex-col overflow-hidden">
        {/* 换 tab 时只让新内容淡入；壳的 flex 链（min-h-0 / flex-1）必须原样透下去，
            否则设备树与文件树会失去可滚动高度。
            设备树的 key 只能是 tab 本身：切 node 时它不重挂（展开态/滚动位置都得留着）。
            智能体随 routeNodeId 重挂，key 带上 node 让重挂淡入而不是直接弹出；
            文件树是跨 node 聚合的，与路由 node 无关，key 只用 tab 名。 */}
        {sidebarTab === 'panes' && (
          <Reveal key="panes" className="flex min-h-0 flex-1 flex-col">
            <SideBarDeviceList />
          </Reveal>
        )}
        {sidebarTab === 'agent' && (
          <Reveal key={`agent:${routeNodeId}`} className="flex min-h-0 flex-1 flex-col">
            <NodeRuntimeScope nodeId={routeNodeId}>
              <Suspense fallback={null}>
                {/* 智能体状态固定由 entry（self）网关提供：绑远端 pane 的会话也由它运行，
                    路由 node 只决定展示哪一批会话、以及设备树/快照来自谁。 */}
                <AgentTab agentStore={selfAgentStore()} nodeOffline={routeNodeOffline} />
              </Suspense>
            </NodeRuntimeScope>
          </Reveal>
        )}
        {sidebarTab === 'files' && (
          <Reveal key="files" className="flex min-h-0 flex-1 flex-col">
            <Suspense fallback={null}>
              <SidebarFilesTab routeNodeId={routeNodeId} routeNodeOffline={routeNodeOffline} />
            </Suspense>
          </Reveal>
        )}
      </SidebarContent>
      {/* 垂直 padding 清零、gap 交给 NavMain：桌面端按钮组下缘与侧栏（即右侧外框）
          下缘齐平；横向仍是 footer px-2 + group px-2，按钮左右位置不变。 */}
      <SidebarFooter className="gap-0 px-2 pt-1.5 pb-0">
        <NavMain items={footerItems} />
        <div className="h-[var(--tmex-safe-area-bottom)]" />
      </SidebarFooter>
    </Sidebar>
  );
}
