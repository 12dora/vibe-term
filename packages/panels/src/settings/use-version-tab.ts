// 版本设置页的数据域：系统信息 / 更新检查 / 升级任务轮询与派生文案。
// 升级会重启服务，因此完成检测靠「见过非 idle 后又回到 idle」而非单次响应。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseApiError } from '@tmex/api-client';
import type { SystemInfo, UpdateCheckResult, UpgradeStatus } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const UPGRADE_POLL_MS = 2000;

export interface VersionTabModel {
  info?: SystemInfo;
  update?: UpdateCheckResult;
  isChecking: boolean;
  isCheckFailed: boolean;
  checkUpdate: () => void;
  isUpgrading: boolean;
  isUpgradeStarting: boolean;
  /** 升级进行中的阶段文案；无进行中阶段为 null */
  upgradeStateText: string | null;
  /** 不能自更新时的原因文案；可自更新或原因不明为 null */
  disabledReason: string | null;
  deploymentLabel: (deployment: SystemInfo['deployment']) => string;
  showConfirm: boolean;
  setShowConfirm: (open: boolean) => void;
  confirmUpgrade: () => void;
}

export function useVersionTab(): VersionTabModel {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { apiClient } = useRuntime();

  const [showConfirm, setShowConfirm] = useState(false);
  // 是否已触发本次升级（用于跨服务重启的完成检测）
  const [pending, setPending] = useState(false);
  const sawActiveRef = useRef(false);

  const infoQuery = useQuery({
    queryKey: ['system-info'],
    queryFn: async () => {
      const res = await apiClient.fetch('/api/system/info');
      if (!res.ok) throw new Error(await parseApiError(res, t('settings.loadFailed')));
      return (await res.json()) as SystemInfo;
    },
  });

  const updateQuery = useQuery({
    queryKey: ['system-update-check'],
    enabled: false,
    gcTime: 0,
    queryFn: async () => {
      const res = await apiClient.fetch('/api/system/update-check');
      if (!res.ok) throw new Error(await parseApiError(res, t('settings.version.checkFailed')));
      return (await res.json()) as UpdateCheckResult;
    },
  });

  const upgradeStatusQuery = useQuery({
    queryKey: ['system-upgrade-status'],
    enabled: pending,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (pending || (state && state !== 'idle')) return UPGRADE_POLL_MS;
      return false;
    },
    retry: true,
    queryFn: async () => {
      const res = await apiClient.fetch('/api/system/upgrade');
      if (!res.ok) throw new Error('status');
      return (await res.json()) as UpgradeStatus;
    },
  });
  const upgradeStatus = upgradeStatusQuery.data;

  // 升级完成检测：见过非 idle 后又回到 idle（服务重启完成）→ 刷新版本信息
  useEffect(() => {
    if (!pending) return;
    const state = upgradeStatus?.state;
    if (state && state !== 'idle') {
      sawActiveRef.current = true;
    } else if (state === 'idle' && upgradeStatus?.error) {
      // 下载阶段失败：仅报错，不再误报成功（error 与 success 分支互斥）
      sawActiveRef.current = false;
      setPending(false);
      toast.error(upgradeStatus.error);
    } else if (state === 'idle' && sawActiveRef.current) {
      // 见过非 idle 后回到 idle 且无错误 → 升级成功（服务已重启）
      sawActiveRef.current = false;
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: ['system-info'] });
      queryClient.removeQueries({ queryKey: ['system-update-check'] });
      toast.success(t('common.success'));
    }
  }, [pending, upgradeStatus, queryClient, t]);

  const startUpgradeMutation = useMutation({
    mutationFn: async (version: string) => {
      const res = await apiClient.fetch('/api/system/upgrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error(await parseApiError(res, t('common.error')));
      return (await res.json()) as UpgradeStatus;
    },
    onSuccess: (status) => {
      sawActiveRef.current = false;
      setPending(true);
      queryClient.setQueryData(['system-upgrade-status'], status);
      toast.success(t('settings.version.upgradeStarted'));
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const info = infoQuery.data;
  const update = updateQuery.data;

  const deploymentLabel = (deployment: SystemInfo['deployment']): string => {
    if (deployment === 'launchd') return t('settings.version.deploymentLaunchd');
    if (deployment === 'systemd') return t('settings.version.deploymentSystemd');
    return t('settings.version.deploymentNone');
  };

  const upgradeStateText =
    upgradeStatus?.state === 'downloading'
      ? t('settings.version.stateDownloading')
      : upgradeStatus?.state === 'executing'
        ? t('settings.version.stateExecuting')
        : null;

  const disabledReason = !info?.canSelfUpdate
    ? !info?.isProd
      ? t('settings.version.upgradeDisabledDev')
      : !info?.installedViaCli
        ? t('settings.version.upgradeDisabledNonCli')
        : null
    : null;

  return {
    info,
    update,
    isChecking: updateQuery.isFetching,
    isCheckFailed: updateQuery.isError,
    checkUpdate: () => {
      void updateQuery.refetch();
    },
    isUpgrading: pending && upgradeStatus?.state !== undefined,
    isUpgradeStarting: startUpgradeMutation.isPending,
    upgradeStateText,
    disabledReason,
    deploymentLabel,
    showConfirm,
    setShowConfirm,
    confirmUpgrade: () => {
      setShowConfirm(false);
      if (update?.latestVersion) {
        startUpgradeMutation.mutate(update.latestVersion);
      }
    },
  };
}
