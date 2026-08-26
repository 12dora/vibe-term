// 文件树节点的共用菜单片段与状态行。

import { formatBytes } from '@tmex/api-client';
import type { FileErrorCode, FileRootDto } from '@tmex/shared';
import type { HostServices } from '@tmex/stores';
import { useRuntime } from '@tmex/stores/react';
import { ContextMenuItem } from '@tmex/ui/context-menu';
import { Bot, Copy, Globe, Link, Monitor, RotateCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fileErrorKey, relativeToRoot } from './file-tree-logic';
import { sendPathToAgent } from './rsync-install-flow';

async function copyText(
  host: HostServices,
  text: string,
  okMsg: string,
  failMsg: string
): Promise<void> {
  try {
    await host.writeClipboardText(text);
    toast.success(okMsg);
  } catch {
    toast.error(failMsg);
  }
}

// 所有 node 共有的菜单项：复制绝对/相对位置、发送到 Agent。
export function CommonNodeMenuItems({
  deviceId,
  absPath,
  rootPath,
}: {
  deviceId: string;
  absPath: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  return (
    <>
      <ContextMenuItem
        onClick={() =>
          void copyText(runtime.host, absPath, t('files.copied'), t('files.copyFailed'))
        }
      >
        <Copy />
        {t('files.menu.copyAbsolute')}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() =>
          void copyText(
            runtime.host,
            relativeToRoot(rootPath, absPath),
            t('files.copied'),
            t('files.copyFailed')
          )
        }
      >
        <Link />
        {t('files.menu.copyRelative')}
      </ContextMenuItem>
      {runtime.features.agentUi && (
        <ContextMenuItem onClick={() => void sendPathToAgent(runtime, deviceId, absPath)}>
          <Bot />
          {t('files.menu.sendToAgent')}
        </ContextMenuItem>
      )}
    </>
  );
}

// 菜单头部：标明所属设备、完整绝对路径（长路径换行）、可选文件大小；避免误操作。
// size 取自目录列表已有的 entry.size（无需额外请求）；为 null（目录/符号链接/未知）时不显示。
export function NodeMenuHeader({
  root,
  absPath,
  size,
}: { root: FileRootDto; absPath: string; size?: number | null }) {
  const DeviceIcon = root.deviceType === 'ssh' ? Globe : Monitor;
  return (
    <div className="px-1.5 pt-1 pb-1.5">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <DeviceIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{root.deviceName ?? root.deviceId}</span>
        </span>
        {size != null && <span className="shrink-0 tabular-nums">{formatBytes(size)}</span>}
      </div>
      <div className="mt-0.5 font-mono text-[11px] break-all text-foreground/70">{absPath}</div>
    </div>
  );
}

export function DeviceBadge({ root }: { root: FileRootDto }) {
  const Icon = root.deviceType === 'ssh' ? Globe : Monitor;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
      <Icon className="h-3 w-3" />
      <span className="max-w-24 truncate">{root.deviceName ?? '—'}</span>
    </span>
  );
}

export function NodeError({
  code,
  indent,
  onRetry,
}: {
  code?: FileErrorCode;
  indent: number;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{ paddingLeft: indent }}
      className="flex items-start gap-1.5 py-1 pr-2 text-[11px] text-destructive/80"
    >
      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1">{t(fileErrorKey(code))}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 text-muted-foreground hover:text-foreground"
        title={t('files.retry')}
      >
        <RotateCw className="h-3 w-3" />
      </button>
    </div>
  );
}
