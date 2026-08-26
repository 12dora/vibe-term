import { useQuery } from '@tanstack/react-query';
import { fetchFileRoots, fetchFileStat } from '@tmex/api-client';
import { type TerminalFileLinksProvider, fileRoute, hostAppPath } from '@tmex/stores';
import { useRuntime, useTmuxStore } from '@tmex/stores/react';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { findPaneCurrentPath, resolveFileLinkRoot } from '../terminalFileLinks';
import type { TerminalProps } from '../types';

export interface UseTerminalFileLinksOptions {
  deviceId: string;
  paneId: string;
  instance: CompatibleTerminalLike | null;
  onOpenFile: TerminalProps['onOpenFile'];
}

/**
 * 终端链接面：外链交给宿主打开；文件链接按授权根 + pane cwd 识别，
 * stat 校验存在后跳转文件预览（宿主可经 runtime.terminalFileLinks 整体替换）。
 */
export function useTerminalFileLinks({
  deviceId,
  paneId,
  instance,
  onOpenFile,
}: UseTerminalFileLinksOptions): void {
  const runtime = useRuntime();
  const { t } = useTranslation();

  // 终端内链接（Mac Cmd+Click / 其它 Ctrl+Click）经宿主打开外链；与连接状态无关。
  useEffect(() => {
    if (!instance?.onLinkActivated) return;
    const disposable = instance.onLinkActivated((url) => {
      void (async () => runtime.host.openExternal(url))().catch(() => {
        runtime.notifications.error(t('terminal.linkOpenFailed'));
      });
    });
    return () => disposable.dispose();
  }, [instance, runtime, t]);

  // 文件链接上下文：该设备已启用的授权根 + 当前 pane 的 cwd，注入终端做候选有效性过滤。
  // 数据与跳转面可经 runtime.terminalFileLinks 整体替换；缺省走 gateway 文件 API 与 /file/:ref 路由。
  const fileLinks = useMemo<TerminalFileLinksProvider>(
    () =>
      runtime.terminalFileLinks ?? {
        listRoots: async (forDeviceId) => {
          const res = await fetchFileRoots(runtime.apiClient);
          return res.roots
            .filter((root) => root.enabled && root.deviceId === forDeviceId)
            .map((root) => ({ id: root.id, path: root.path }));
        },
        stat: (rootId, path) => fetchFileStat(rootId, path, runtime.apiClient),
        openFile: (rootId, path) =>
          runtime.host.navigate(hostAppPath(runtime.host, fileRoute(rootId, path))),
      },
    [runtime]
  );
  const { data: fileRootsData } = useQuery({
    queryKey: ['terminal-file-links', 'roots', deviceId],
    queryFn: () => fileLinks.listRoots(deviceId),
    staleTime: 30_000,
  });
  const fileLinkRoots = useMemo(() => fileRootsData ?? [], [fileRootsData]);
  const paneCurrentPath = useTmuxStore((state) =>
    findPaneCurrentPath(state.snapshots[deviceId]?.session, paneId)
  );

  useEffect(() => {
    instance?.setFileLinkContext?.({
      cwd: paneCurrentPath ?? null,
      rootPaths: fileLinkRoots.map((root) => root.path),
    });
  }, [instance, paneCurrentPath, fileLinkRoots]);

  // 文件链接点击：最长前缀匹配定位 root，stat 校验存在后跳转文件预览。
  useEffect(() => {
    if (!instance?.onFileLinkActivated) return;
    const disposable = instance.onFileLinkActivated((path) => {
      const root = resolveFileLinkRoot(fileLinkRoots, path);
      if (!root) return;
      void fileLinks
        .stat(root.id, path)
        .then(() => {
          if (onOpenFile) {
            onOpenFile(root.id, path);
          } else {
            fileLinks.openFile(root.id, path);
          }
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.fileLinkNotFound'));
        });
    });
    return () => disposable.dispose();
  }, [instance, fileLinkRoots, fileLinks, onOpenFile, runtime, t]);
}
