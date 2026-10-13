// 文件管理器页。路由不带节点前缀：页面运行时恒为入口节点，各标签页在主体里各自挂所属节点的运行时。
// PageTitle / PageActions 渲染在页面组件树之外（见 page-wrapper.tsx），只能用共享 store 与运行时 hook，
// 拿不到 ExplorerTransferProvider 的 context。

import { useNarrowLayout } from '@/components/use-narrow-layout';
import { EXPLORER_MAX_PANES, explorerActiveTab } from '@vibeterm/stores';
import { useExplorerStore } from '@vibeterm/stores/react';
import { Button } from '@vibeterm/ui/button';
import { IconTooltip } from '@vibeterm/ui/icon-tooltip';
import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ExplorerTransfersButton } from './explorer/explorer-transfers-popover';
import { ExplorerWorkspace } from './explorer/explorer-workspace';
import { ExplorerTransferProvider } from './explorer/use-explorer-transfer';
import { useWorkspaceActions } from './explorer/workspace-actions';

export default function ExplorerPage() {
  return (
    <ExplorerTransferProvider>
      <ExplorerWorkspace />
    </ExplorerTransferProvider>
  );
}

export function PageTitle() {
  const { t } = useTranslation();
  return <>{t('explorer.title')}</>;
}

function SplitButton() {
  const { t } = useTranslation();
  const activeTabId = useExplorerStore((state) => explorerActiveTab(state)?.id ?? null);
  const atMaxPanes = useExplorerStore((state) => state.panes.length >= EXPLORER_MAX_PANES);
  const narrow = useNarrowLayout();
  const { splitTab } = useWorkspaceActions();
  const label = t('explorer.toolbar.split');

  return (
    <IconTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="explorer-split"
        aria-label={label}
        disabled={activeTabId === null || atMaxPanes || narrow}
        onClick={() => activeTabId !== null && splitTab(activeTabId)}
      >
        <Columns2 className="h-4 w-4" />
      </Button>
    </IconTooltip>
  );
}

export function PageActions() {
  return (
    <div className="flex items-center gap-0.5">
      <SplitButton />
      <ExplorerTransfersButton />
    </div>
  );
}
