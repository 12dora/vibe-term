// 文件侧栏的外壳：标题 + 刷新 + 可滚动区。
//
// 单 node 宿主直接渲染当前运行时的文件树；多 node 宿主把每个 node 的分节
// （`FilesNodeSection`，各自套自己的运行时）作为 `sections` 传进来，外壳只管头部与滚动。

import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useRuntime } from '@tmex/stores/react';
import { cn } from '@tmex/ui';
import { Button } from '@tmex/ui/button';
import { ScrollArea } from '@tmex/ui/scroll-area';
import { SidebarGroup } from '@tmex/ui/sidebar';
import { RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { FilesNodeRoots } from './files-node-roots';
import { hasExternalFiles } from './use-directory-upload';

export interface FilesTabProps {
  /** 不渲染头部行（标题 + 刷新按钮）；宿主连续渲染多个实例时避免重复头部。 */
  hideHeader?: boolean;
  /** 该 runtime 所属 node 已离线：只留一行提示，不发请求也不显示陈旧目录。 */
  nodeOffline?: boolean;
  /** 多 node 聚合：宿主渲染好的各 node 分节；未传即渲染当前运行时的单节文件树。 */
  sections?: ReactNode;
  /** 聚合视图的刷新（每个 node 一份缓存，只能由宿主逐个失效）；未传即失效当前 QueryClient。 */
  onRefresh?: () => void;
}

// 外壳门：runtime.features.filesUi 关断、或所属 node 离线时都不渲染文件树，
// 也不发起 files 查询（内层 hooks 不执行）；node 回线后内层重挂自动重新拉取。
export function FilesTab(props: FilesTabProps = {}) {
  const { features } = useRuntime();
  const { t } = useTranslation();
  if (!features.filesUi) return null;
  if (props.nodeOffline) {
    return (
      <SidebarGroup className="flex min-h-0 flex-1 flex-col pt-0" data-testid="files-tab">
        <div
          data-testid="files-node-offline"
          className="px-3 py-6 text-center text-xs text-muted-foreground"
        >
          {t('files.nodeOffline')}
        </div>
      </SidebarGroup>
    );
  }
  return <FilesTabInner {...props} />;
}

function FilesTabInner({ hideHeader, sections, onRefresh }: FilesTabProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isFetching = useIsFetching({ queryKey: ['files'] });

  const refresh = () => {
    if (onRefresh) {
      onRefresh();
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['files'] });
  };

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col pt-0" data-testid="files-tab">
      {!hideHeader && (
        <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
          <span className="truncate text-xs font-medium text-muted-foreground">
            {t('files.title')}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={refresh}
            title={t('files.refresh')}
            data-testid="files-refresh"
          >
            <RotateCw className={cn('h-3.5 w-3.5', isFetching > 0 && 'animate-spin')} />
          </Button>
        </div>
      )}
      {/* 只纵向滚：拖拽时被拖的行若横移，横向溢出会把侧栏拽偏（见 device-tree-dnd 的 modifier） */}
      <ScrollArea axis="vertical" className="min-h-0 flex-1">
        <div
          // 兜底：阻止把文件拖到非文件夹区域时浏览器默认打开/导航；真正的上传由 DirNode 的 onDrop 处理
          onDragOver={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          onDrop={(e) => {
            if (hasExternalFiles(e)) e.preventDefault();
          }}
          className="min-w-0 space-y-0.5 pr-1 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]"
        >
          {sections ?? <FilesNodeRoots />}
        </div>
      </ScrollArea>
    </SidebarGroup>
  );
}
