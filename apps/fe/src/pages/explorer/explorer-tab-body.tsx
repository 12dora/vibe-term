// 一个标签页的主体：先按节点状态分流（未知 / 离线 / 未登录），可用时挂上该节点的运行时
// 再渲染按需加载的文件浏览器。每个分栏只挂活动标签页，切换靠目录列表缓存保持即时。

import { NodeLoginButton } from '@/auth/NodeLoginButton';
import { lazyChunk } from '@/lazy-chunk';
import { NodeRuntimeScope } from '@/node/node-runtime-scope';
import type { DialogNodeOption } from '@/pages/devices/dialog-nodes';
import { SELF_NODE_ID } from '@vibeterm/api-client';
import type { ExplorerBrowserProps } from '@vibeterm/panels/explorer';
import { SettingsEventsInit } from '@vibeterm/panels/settings/events';
import {
  type ExplorerTab,
  explorerCanGoBack,
  explorerCanGoForward,
  explorerTabPath,
} from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/react';
import { CloudOff, FolderX, Loader2, LogIn, ServerOff } from 'lucide-react';
import { Suspense, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useExplorerNodes } from './explorer-nodes';
import { CloseTabButton, ExplorerStateScreen } from './explorer-state';
import { useExplorerTransferActions } from './use-explorer-transfer';
import { useTabNavigation } from './use-tab-navigation';
import { useWorkspaceActions } from './workspace-actions';

const ExplorerBrowser = lazyChunk<ExplorerBrowserProps>(() =>
  import('@vibeterm/panels/explorer').then((m) => m.ExplorerBrowser)
);

export interface ExplorerTabBodyProps {
  tab: ExplorerTab;
  /** 这个标签页是键盘焦点的归属：活动分栏里的活动标签页 */
  active: boolean;
}

function LoadingState() {
  return <ExplorerStateScreen kind="loading" icon={Loader2} spin />;
}

interface TabBrowserProps extends ExplorerTabBodyProps {
  onRootMissing(): void;
}

function TabBrowser({ tab, active, onRootMissing }: TabBrowserProps) {
  const viewMode = useExplorerStore((state) => state.viewMode);
  const showHidden = useExplorerStore((state) => state.showHidden);
  const sort = useExplorerStore((state) => state.sort);
  const clipboard = useExplorerStore((state) => state.clipboard);
  const actions = useWorkspaceActions();
  const { run } = useExplorerTransferActions();
  const navigation = useTabNavigation(tab);
  const { id: tabId, nodeId, rootId } = tab;

  const onOpenInNewTab = useCallback(
    (path: string) => actions.openLocation({ nodeId, rootId, path }, { newTab: true }),
    [actions, nodeId, rootId]
  );
  const onCommand = useCallback(
    (command: 'newTab' | 'closeTab' | 'split') => {
      if (command === 'split') actions.splitTab(tabId);
      else if (command === 'newTab') actions.duplicateTab(tabId);
      else actions.closeTab(tabId);
    },
    [actions, tabId]
  );
  const onActivate = useCallback(() => actions.activateTab(tabId), [actions, tabId]);

  return (
    <ExplorerBrowser
      tabId={tabId}
      rootId={rootId}
      path={explorerTabPath(tab)}
      canBack={explorerCanGoBack(tab)}
      canForward={explorerCanGoForward(tab)}
      active={active}
      viewMode={viewMode}
      showHidden={showHidden}
      sort={sort}
      clipboard={clipboard}
      {...navigation}
      onOpenInNewTab={onOpenInNewTab}
      onViewModeChange={actions.setViewMode}
      onShowHiddenChange={actions.setShowHidden}
      onSortChange={actions.setSort}
      onClipboardChange={actions.setClipboard}
      onTransfer={run}
      onCommand={onCommand}
      onActivate={onActivate}
      onRootMissing={onRootMissing}
    />
  );
}

interface NodeGateProps {
  tab: ExplorerTab;
  node: DialogNodeOption | undefined;
  ready: boolean;
}

/** 节点不可用时的占位；可用返回 null */
function NodeGate({ tab, node, ready }: NodeGateProps) {
  const { t } = useTranslation();
  const { closeTab } = useWorkspaceActions();

  if (!node) {
    // 成员表还没到齐时查不到不代表节点没了
    if (!ready) return <LoadingState />;
    return (
      <ExplorerStateScreen
        kind="nodeMissing"
        icon={ServerOff}
        text={t('explorer.state.nodeMissing')}
      >
        <CloseTabButton onClose={() => closeTab(tab.id)} />
      </ExplorerStateScreen>
    );
  }
  if (!node.online) {
    return <ExplorerStateScreen kind="offline" icon={CloudOff} text={t('files.nodeOffline')} />;
  }
  if (!node.loggedIn) {
    return (
      <ExplorerStateScreen kind="signedOut" icon={LogIn} text={t('files.nodeSignInHint')}>
        <NodeLoginButton nodeId={tab.nodeId} nodeName={node.name} />
      </ExplorerStateScreen>
    );
  }
  return null;
}

export function ExplorerTabBody({ tab, active }: ExplorerTabBodyProps) {
  const { t } = useTranslation();
  const nodes = useExplorerNodes();
  const { closeTab } = useWorkspaceActions();
  // 记下失效的是哪个目录根：标签页换了根之后要重新给浏览器一次机会
  const [missingRootId, setMissingRootId] = useState<string | null>(null);
  const rootId = tab.rootId;
  const onRootMissing = useCallback(() => setMissingRootId(rootId), [rootId]);

  const node = nodes.find(tab.nodeId);
  if (!node || !node.online || !node.loggedIn) {
    return <NodeGate tab={tab} node={node} ready={nodes.ready} />;
  }
  if (missingRootId === rootId) {
    return (
      <ExplorerStateScreen kind="rootMissing" icon={FolderX} text={t('explorer.state.rootMissing')}>
        <CloseTabButton onClose={() => closeTab(tab.id)} />
      </ExplorerStateScreen>
    );
  }
  return (
    <NodeRuntimeScope nodeId={tab.nodeId}>
      {/* 远端节点的设置事件订阅只能挂在这里（self 恒由 main.tsx 覆盖），同侧栏文件分节 */}
      {tab.nodeId !== SELF_NODE_ID && <SettingsEventsInit />}
      <Suspense fallback={<LoadingState />}>
        <TabBrowser tab={tab} active={active} onRootMissing={onRootMissing} />
      </Suspense>
    </NodeRuntimeScope>
  );
}
