// rsync 缺失：弹出带「自动安装」按钮的 toast（仅当配置过 LLM），一次/恢复后重置。

import type { FileErrorCode, FileRootDto } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { fileErrorKey, resolveRsyncInstallDeviceId, rsyncMissingSide } from './file-tree-logic';
import { buildRsyncInstallPrompt, triggerRsyncInstall } from './rsync-install-flow';

export interface RsyncMissingToastInput {
  root: FileRootDto;
  nodeKey: string;
  errCode?: FileErrorCode;
  llmConfigured: boolean;
  localDeviceId: string | null;
}

export function useRsyncMissingToast({
  root,
  nodeKey,
  errCode,
  llmConfigured,
  localDeviceId,
}: RsyncMissingToastInput): void {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const toastFiredRef = useRef<string | null>(null);

  useEffect(() => {
    const side = rsyncMissingSide(errCode);
    if (!side) {
      toastFiredRef.current = null;
      return;
    }
    if (toastFiredRef.current === nodeKey) return;
    toastFiredRef.current = nodeKey;

    const remote = side === 'remote';
    const installDeviceId = resolveRsyncInstallDeviceId(root, side, localDeviceId);

    const toastId = `rsync-missing-${nodeKey}`;
    toast.error(t(fileErrorKey(errCode)), {
      id: toastId,
      description: root.deviceName ? `${root.deviceName}` : undefined,
      action:
        runtime.features.agentUi && llmConfigured && installDeviceId
          ? {
              label: t('files.install.button'),
              onClick: () => {
                // 一次性：立即清除当前 toast，再触发安装编排
                toast.dismiss(toastId);
                void triggerRsyncInstall(
                  runtime,
                  installDeviceId,
                  buildRsyncInstallPrompt(root.deviceName ?? root.deviceId, remote)
                );
              },
            }
          : undefined,
    });
  }, [errCode, nodeKey, root, llmConfigured, localDeviceId, t, runtime]);
}
