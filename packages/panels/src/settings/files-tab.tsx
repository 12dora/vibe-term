import { useQuery } from '@tanstack/react-query';
import { Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { fetchDevices } from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';

import { FileRootFormModal } from './file-root-form-modal';
import {
  type FileRootDeviceGroup,
  type FileRootEntry,
  filterFileRootEntries,
  resolveFileRootsListState,
  useFileRootsQuery,
} from './file-root-query';
import { FileRootRow } from './file-root-row';
import { SETTINGS_STALE_MS } from './settings-query';

export type {
  FileRootDeviceGroup,
  FileRootDeviceOption,
} from './file-root-query';

export interface FilesSettingsTabProps {
  /**
   * 注入设备清单数据源（分组显示）。同时决定 file roots 的读写路径：列表聚合各组
   * client 的 roots，创建/更新/删除路由到对应组的 client。缺省（不传）取本 gateway
   * 的 /api/devices 且读写本 gateway。
   */
  deviceGroups?: FileRootDeviceGroup[];
  /**
   * roots 增删改成功后的通知。组件内部只失效自身 QueryClient 的 ['files'] 缓存，
   * 宿主若在其他缓存域（另一个 QueryClient）也展示 roots，可借此扇出失效。
   */
  onRootsMutated?: () => void;
  /**
   * 单设备模式：隐藏设备选择器（只读展示），新增的 root 一律落在该设备上，
   * 列表也只显示该设备的 roots。设备卡片里的「目录」弹窗用它。
   */
  lockedDeviceId?: string;
  /** 覆盖卡片标题；缺省用「文件」 */
  title?: string;
}

// 外壳门：runtime.features.filesUi 关断时不渲染文件根设置卡，也不发起 files 查询（内层 hooks 不执行）。
export function FilesSettingsTab(props: FilesSettingsTabProps = {}) {
  const { features } = useRuntime();
  if (!features.filesUi) return null;
  return <FilesSettingsTabInner {...props} />;
}

function FileRootsError({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center gap-2 py-6 text-center"
      data-testid="settings-files-error"
    >
      <span className="flex items-center gap-1.5 text-sm text-destructive">
        <TriangleAlert className="h-4 w-4 shrink-0" />
        {t('settings.files.loadFailed')}
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid="settings-files-retry"
        onClick={onRetry}
        disabled={retrying}
      >
        {t('common.retry')}
      </Button>
    </div>
  );
}

function FilesSettingsTabInner({
  deviceGroups,
  onRootsMutated,
  lockedDeviceId,
  title,
}: FilesSettingsTabProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<FileRootEntry | undefined>(undefined);

  const rootsQuery = useFileRootsQuery(deviceGroups);

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(apiClient),
    throwOnError: false,
    enabled: !deviceGroups,
    // 只喂新增/编辑弹窗的设备下拉，不必跟着实时状态走
    staleTime: SETTINGS_STALE_MS,
  });

  const entries = filterFileRootEntries(rootsQuery.data ?? [], lockedDeviceId);
  const devices = devicesQuery.data?.devices ?? [];
  const listState = resolveFileRootsListState({
    isLoading: rootsQuery.isLoading,
    isError: rootsQuery.isError,
    entryCount: entries.length,
  });

  const openAdd = () => {
    setEditingEntry(undefined);
    setModalOpen(true);
  };

  const openEdit = (entry: FileRootEntry) => {
    setEditingEntry(entry);
    setModalOpen(true);
  };

  return (
    <>
      <Card className="border-0 ring-0" data-testid="settings-files-section">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>{title ?? t('settings.files.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {lockedDeviceId
                ? t('settings.files.lockedDescription')
                : t('settings.files.description')}
            </p>
          </div>
          <Button variant="secondary" data-testid="settings-files-root-add" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('settings.files.addRoot')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {listState === 'loading' && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {listState === 'error' && (
            <FileRootsError
              onRetry={() => void rootsQuery.refetch()}
              retrying={rootsQuery.isFetching}
            />
          )}

          {listState === 'empty' && (
            <div className="text-sm text-muted-foreground" data-testid="settings-files-empty">
              {t('settings.files.empty')}
            </div>
          )}

          {entries.map((entry) => (
            <FileRootRow
              key={entry.root.id}
              root={entry.root}
              client={entry.client}
              onEdit={() => openEdit(entry)}
              onRootsMutated={onRootsMutated}
            />
          ))}
        </CardContent>
      </Card>

      <FileRootFormModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        root={editingEntry?.root}
        editClient={editingEntry?.client}
        devices={devices}
        deviceGroups={deviceGroups}
        lockedDeviceId={lockedDeviceId}
        onRootsMutated={onRootsMutated}
      />
    </>
  );
}
