import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileRootDto, UpdateFileRootRequest } from '@tmex/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  type ApiClient,
  FileApiError,
  deleteFileRoot,
  fetchDevices,
  fetchFileRoots,
  updateFileRoot,
} from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@tmex/ui/alert-dialog';
import { Button } from '@tmex/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@tmex/ui/card';
import { Switch } from '@tmex/ui/switch';

import { DeviceIcon, FileRootFormModal } from './file-root-form-modal';
import { type FileRootDeviceGroup, collectFileRootClients } from './file-root-form-model';

export type { FileRootDeviceGroup, FileRootDeviceOption } from './file-root-form-model';

const SETTINGS_FILE_ROOTS_QUERY_KEY = ['files', 'settings', 'roots'] as const;

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
}

/** 聚合列表里的一条 root 及其来源 client（更新/删除沿用来源）。 */
interface FileRootEntry {
  root: FileRootDto;
  client: ApiClient;
}

// 外壳门：runtime.features.filesUi 关断时不渲染文件根设置卡，也不发起 files 查询（内层 hooks 不执行）。
export function FilesSettingsTab(props: FilesSettingsTabProps = {}) {
  const { features } = useRuntime();
  if (!features.filesUi) return null;
  return <FilesSettingsTabInner {...props} />;
}

function FilesSettingsTabInner({ deviceGroups, onRootsMutated }: FilesSettingsTabProps) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<FileRootEntry | undefined>(undefined);

  const rootsQuery = useQuery({
    queryKey: SETTINGS_FILE_ROOTS_QUERY_KEY,
    queryFn: async (): Promise<FileRootEntry[]> => {
      const clients = collectFileRootClients(apiClient, deviceGroups);
      const results = await Promise.all(clients.map((client) => fetchFileRoots(client)));
      return results.flatMap((res, index) =>
        res.roots.map((root) => ({ root, client: clients[index] }))
      );
    },
  });

  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: () => fetchDevices(apiClient),
    throwOnError: false,
    enabled: !deviceGroups,
  });

  const entries = rootsQuery.data ?? [];
  const devices = devicesQuery.data?.devices ?? [];

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
            <CardTitle>{t('settings.files.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('settings.files.description')}</p>
          </div>
          <Button variant="secondary" data-testid="settings-files-root-add" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            {t('settings.files.addRoot')}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {rootsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">{t('common.loading')}</div>
          )}

          {!rootsQuery.isLoading && entries.length === 0 && (
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
        onRootsMutated={onRootsMutated}
      />
    </>
  );
}

interface FileRootRowProps {
  root: FileRootDto;
  /** 该 root 的来源 client：更新/删除沿用 */
  client: ApiClient;
  onEdit: () => void;
  onRootsMutated?: () => void;
}

function FileRootRow({ root, client, onEdit, onRootsMutated }: FileRootRowProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateFileRoot(id, { enabled } satisfies UpdateFileRootRequest, client),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
    },
    onError: () => {
      toast.error(t('settings.files.toggleFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteFileRoot(id, client),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['files'] });
      onRootsMutated?.();
      toast.success(t('common.success'));
    },
    onError: (err) => {
      const message = err instanceof FileApiError ? err.message : t('settings.files.deleteFailed');
      toast.error(message);
    },
  });

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border p-3"
      data-testid={`settings-files-root-${root.id}`}
    >
      <Switch
        checked={root.enabled}
        disabled={toggleMutation.isPending}
        onCheckedChange={(checked) =>
          toggleMutation.mutate({ id: root.id, enabled: Boolean(checked) })
        }
        data-testid={`settings-files-root-enabled-${root.id}`}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <DeviceIcon type={root.deviceType} className="h-3.5 w-3.5 shrink-0" />
          {root.deviceName === null ? (
            <span className="text-destructive">{t('settings.files.missing')}</span>
          ) : (
            <span className="truncate">{root.deviceName}</span>
          )}
        </div>
        <div className="truncate font-mono text-xs">{root.path}</div>
        <div className="truncate text-xs text-muted-foreground">{root.name}</div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.edit')}
          data-testid={`settings-files-root-edit-${root.id}`}
          onClick={onEdit}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.delete')}
          data-testid={`settings-files-root-delete-${root.id}`}
          onClick={() => setShowDeleteConfirm(true)}
          disabled={deleteMutation.isPending}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10">
              <Trash2 className="h-5 w-5 text-destructive" />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('settings.files.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings.files.deleteDesc', { path: root.path })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid={`settings-files-root-delete-confirm-${root.id}`}
              onClick={() => {
                deleteMutation.mutate(root.id);
                setShowDeleteConfirm(false);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
