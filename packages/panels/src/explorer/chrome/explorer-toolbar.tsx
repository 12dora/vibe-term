// 文件管理器工具条：导航 | 地址栏 | 筛选 | 新建/上传 | 视图切换 | 更多。纯展示，状态全部由调用方给。

import type { FileRootDto } from '@vibeterm/shared';
import type { ExplorerViewMode } from '@vibeterm/stores';
import { cn } from '@vibeterm/ui';
import { ArrowLeft, ArrowRight, ArrowUp, FolderPlus, RotateCw, Upload } from 'lucide-react';
import { type DragEvent, type RefObject, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExplorerBreadcrumb } from './explorer-breadcrumb';
import { MoreMenu, ToolbarFilter, ToolbarIconButton, ViewToggle } from './toolbar-controls';

export interface ExplorerToolbarProps {
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  busy: boolean;
  rootPath: string;
  rootName: string;
  path: string;
  roots: readonly FileRootDto[];
  rootId: string;
  viewMode: ExplorerViewMode;
  showHidden: boolean;
  query: string;
  filterInputRef: RefObject<HTMLInputElement | null>;
  onBack(): void;
  onForward(): void;
  onUp(): void;
  onRefresh(): void;
  onNavigate(path: string): void;
  onSwitchRoot(rootId: string): void;
  onNewFolder(): void;
  onUpload(): void;
  onViewModeChange(mode: ExplorerViewMode): void;
  onShowHiddenChange(show: boolean): void;
  onQueryChange(query: string): void;
  onShowShortcuts(): void;
  /** 可选：把拖放落到某一级面包屑上的事件透传给调用方 */
  onDropOnCrumb?(path: string, event: DragEvent): void;
}

function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 hidden h-4 w-px shrink-0 bg-border @[36rem]:block" />;
}

type NavClusterProps = Pick<
  ExplorerToolbarProps,
  'canBack' | 'canForward' | 'canUp' | 'busy' | 'onBack' | 'onForward' | 'onUp' | 'onRefresh'
>;

function NavCluster(props: NavClusterProps) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ToolbarIconButton
        label={t('explorer.toolbar.back')}
        testId="explorer-back"
        command="back"
        disabled={!props.canBack}
        onClick={props.onBack}
      >
        <ArrowLeft />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t('explorer.toolbar.forward')}
        testId="explorer-forward"
        command="forward"
        disabled={!props.canForward}
        onClick={props.onForward}
      >
        <ArrowRight />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t('explorer.toolbar.up')}
        testId="explorer-up"
        command="up"
        disabled={!props.canUp}
        onClick={props.onUp}
      >
        <ArrowUp />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t('explorer.toolbar.refresh')}
        testId="explorer-refresh"
        busy={props.busy}
        onClick={props.onRefresh}
      >
        <RotateCw className={cn(props.busy && 'animate-spin motion-reduce:animate-none')} />
      </ToolbarIconButton>
    </div>
  );
}

function ActionCluster({
  onNewFolder,
  onUpload,
}: Pick<ExplorerToolbarProps, 'onNewFolder' | 'onUpload'>) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <ToolbarIconButton
        label={t('explorer.toolbar.newFolder')}
        testId="explorer-new-folder"
        command="newFolder"
        onClick={onNewFolder}
      >
        <FolderPlus />
      </ToolbarIconButton>
      <ToolbarIconButton
        label={t('explorer.toolbar.upload')}
        testId="explorer-upload"
        onClick={onUpload}
      >
        <Upload />
      </ToolbarIconButton>
    </div>
  );
}

export function ExplorerToolbar(props: ExplorerToolbarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const filterExpanded = filterOpen || props.query !== '';

  return (
    <div
      role="toolbar"
      data-testid="explorer-toolbar"
      className="@container h-10 shrink-0 border-b border-border"
    >
      <div className="flex h-full items-center gap-1 px-2">
        <NavCluster {...props} />
        <ToolbarDivider />
        {/* 窄容器下筛选框展开时让出整行，地址栏暂时收起 */}
        <div className={cn('min-w-0 flex-1', filterExpanded ? 'hidden @[30rem]:flex' : 'flex')}>
          <ExplorerBreadcrumb
            rootPath={props.rootPath}
            rootName={props.rootName}
            path={props.path}
            roots={props.roots}
            rootId={props.rootId}
            onNavigate={props.onNavigate}
            onSwitchRoot={props.onSwitchRoot}
            onDropOnCrumb={props.onDropOnCrumb}
          />
        </div>
        <ToolbarFilter
          query={props.query}
          expanded={filterExpanded}
          inputRef={props.filterInputRef}
          onQueryChange={props.onQueryChange}
          onExpandedChange={setFilterOpen}
        />
        <ToolbarDivider />
        <ActionCluster onNewFolder={props.onNewFolder} onUpload={props.onUpload} />
        <ViewToggle viewMode={props.viewMode} onViewModeChange={props.onViewModeChange} />
        <MoreMenu
          showHidden={props.showHidden}
          onShowHiddenChange={props.onShowHiddenChange}
          onShowShortcuts={props.onShowShortcuts}
        />
      </div>
    </div>
  );
}
