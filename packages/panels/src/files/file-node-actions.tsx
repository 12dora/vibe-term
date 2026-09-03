// 文件叶子的动作：应用内下载（流式 + 可取消进度 Toast）、拖到 OS 下载、右键菜单内容。
//
// 三个动作都由树根**一处**持有（`FileLeafContextMenu` 事件委托），entry 由调用方在触发时传入：
// 每行各调一次 `useFileNodeActions` 会重复建 500 份闭包与 500 次 `useTranslation`。

import { fileDownloadUrl } from '@tmex/api-client';
import type { FileEntryDto, FileRootDto } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from '@tmex/ui/context-menu';
import { Download, FolderOpen } from 'lucide-react';
import type { DragEvent } from 'react';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { downloadFileWithTransport } from './bulk-transfer';
import { CommonNodeMenuItems, NodeMenuHeader } from './node-menu';
import { startTransferToast } from './transfer-toast';

export interface FileNodeActions {
  download: (rootId: string, entry: FileEntryDto) => Promise<void>;
  onDragStart: (event: DragEvent<HTMLElement>, rootId: string, entry: FileEntryDto) => void;
  onDragEnd: (event: DragEvent<HTMLElement>, entry: FileEntryDto) => void;
}

export function useFileNodeActions(): FileNodeActions {
  const { t } = useTranslation();
  const runtime = useRuntime();

  // 应用内下载：流式拉取 + 进度 Toast（可取消）→ 宿主 saveFile 保存。
  const download = useCallback(
    async (rootId: string, entry: FileEntryDto) => {
      const controller = new AbortController();
      const tt = startTransferToast(entry.name, 'download', () => controller.abort());
      try {
        const { name, blob } = await downloadFileWithTransport(
          runtime.nodeId,
          rootId,
          entry.path,
          entry.name,
          { onLeg: tt.leg, signal: controller.signal, onPath: (p) => tt.setPath?.(p) },
          runtime.apiClient
        );
        await runtime.host.saveFile({ name, blob });
        tt.success(t('files.transfer.downloaded', { name: entry.name }));
      } catch {
        if (controller.signal.aborted) tt.cancel();
        else tt.fail(t('files.transfer.downloadFailed', { name: entry.name }));
      }
    },
    [runtime, t]
  );

  return useMemo<FileNodeActions>(
    () => ({
      download,
      onDragStart: (e, rootId, entry) => {
        // 拖到系统下载（仅 Chromium 生效，URL 必须绝对；其它浏览器静默无效，菜单「下载」兜底）
        const absUrl = window.location.origin + fileDownloadUrl(runtime.nodeId, rootId, entry.path);
        e.dataTransfer.setData('DownloadURL', `application/octet-stream:${entry.name}:${absUrl}`);
        e.dataTransfer.effectAllowed = 'copy';
      },
      onDragEnd: (e, entry) => {
        // 拖到 OS 成功放下时（dropEffect=copy）由浏览器接管下载，JS 无进度可显示，
        // 仅给一个轻提示让用户知道下载已开始（去浏览器下载区查看进度）
        if (e.dataTransfer.dropEffect === 'copy') {
          toast(t('files.transfer.dragDownloadStarted', { name: entry.name }));
        }
      },
    }),
    [download, runtime.nodeId, t]
  );
}

export function FileNodeMenuContent({
  root,
  entry,
  onOpen,
  onDownload,
}: {
  root: FileRootDto;
  entry: FileEntryDto;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenuContent>
      <NodeMenuHeader root={root} absPath={entry.path} size={entry.size} />
      <ContextMenuSeparator />
      <ContextMenuItem onClick={onOpen}>
        <FolderOpen />
        {t('files.menu.open')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onDownload} data-testid={`file-download-${root.id}-${entry.path}`}>
        <Download />
        {t('files.download')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <CommonNodeMenuItems deviceId={root.deviceId} absPath={entry.path} rootPath={root.path} />
    </ContextMenuContent>
  );
}
