import {
  type UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateFileRootRequest,
  DeviceType,
  FileRootDto,
  UpdateFileRootRequest,
} from '@tmex/shared';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  type ApiClient,
  FileApiError,
  createFileRoot,
  deleteFileRoot,
  fetchFileRoots,
  updateFileRoot,
} from '@tmex/api-client';
import { useRuntime } from '@tmex/stores/react';

export const SETTINGS_FILE_ROOTS_QUERY_KEY = ['files', 'settings', 'roots'] as const;
const FILE_ROOTS_INVALIDATE_KEY = ['files'] as const;

/** 增改弹窗设备选择器里的一个可选设备。 */
export interface FileRootDeviceOption {
  id: string;
  name: string;
  type?: DeviceType;
}

/** 注入的设备分组：组标签 + 组内设备 + 该组 file roots 的落盘 client。 */
export interface FileRootDeviceGroup {
  label: string;
  devices: FileRootDeviceOption[];
  /** 缺省用当前 runtime 的 apiClient */
  apiClient?: ApiClient;
}

/** 聚合列表里的一条 root 及其来源 client（更新/删除沿用来源）。 */
export interface FileRootEntry {
  root: FileRootDto;
  client: ApiClient;
}

/** 单设备模式只显示锁定设备的 roots；未锁定时原样返回。 */
export function filterFileRootEntries(
  entries: FileRootEntry[],
  lockedDeviceId: string | undefined
): FileRootEntry[] {
  if (!lockedDeviceId) return entries;
  return entries.filter((entry) => entry.root.deviceId === lockedDeviceId);
}

export type FileRootsListState = 'loading' | 'error' | 'empty' | 'ready';

export interface FileRootsListStateInput {
  isLoading: boolean;
  isError: boolean;
  entryCount: number;
}

export function resolveFileRootsListState({
  isLoading,
  isError,
  entryCount,
}: FileRootsListStateInput): FileRootsListState {
  if (isLoading) return 'loading';
  if (entryCount > 0) return 'ready';
  return isError ? 'error' : 'empty';
}

/** 分组去重后的落盘 client 列表；未注入分组时只有 runtime 自身的 client。 */
export function collectFileRootClients(
  deviceGroups: FileRootDeviceGroup[] | undefined,
  fallback: ApiClient
): ApiClient[] {
  if (!deviceGroups) return [fallback];
  const clients: ApiClient[] = [];
  for (const group of deviceGroups) {
    const client = group.apiClient ?? fallback;
    if (!clients.includes(client)) clients.push(client);
  }
  return clients;
}

/** 新增 root 时按目标设备所属分组挑选落盘 client。 */
export function resolveFileRootClient(
  deviceGroups: FileRootDeviceGroup[] | undefined,
  fallback: ApiClient,
  deviceId: string
): ApiClient {
  if (!deviceGroups) return fallback;
  const group = deviceGroups.find((item) => item.devices.some((device) => device.id === deviceId));
  return group?.apiClient ?? fallback;
}

async function fetchFileRootEntries(clients: ApiClient[]): Promise<FileRootEntry[]> {
  const results = await Promise.all(clients.map((client) => fetchFileRoots(client)));
  return results.flatMap((res, index) =>
    res.roots.map((root) => ({ root, client: clients[index] }))
  );
}

export function useFileRootsQuery(deviceGroups?: FileRootDeviceGroup[]) {
  const { apiClient } = useRuntime();
  return useQuery({
    queryKey: SETTINGS_FILE_ROOTS_QUERY_KEY,
    queryFn: () => fetchFileRootEntries(collectFileRootClients(deviceGroups, apiClient)),
  });
}

export function resolveFileRootErrorMessage(err: unknown, fallback: string): string {
  return err instanceof FileApiError ? err.message : fallback;
}

/** 增删改共用的回调：缓存失效之外的扇出与「完成后关窗」。 */
export interface FileRootMutationHandlers {
  onRootsMutated?: () => void;
  onDone?: () => void;
}

interface FileRootMutationConfig<TVars> {
  mutationFn: (vars: TVars) => Promise<unknown>;
  fallbackMessage: string;
  notifySuccess: boolean;
  handlers: FileRootMutationHandlers;
}

function useFileRootMutation<TVars>({
  mutationFn,
  fallbackMessage,
  notifySuccess,
  handlers,
}: FileRootMutationConfig<TVars>): UseMutationResult<unknown, Error, TVars> {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: FILE_ROOTS_INVALIDATE_KEY });
      handlers.onRootsMutated?.();
      if (notifySuccess) toast.success(t('common.success'));
      handlers.onDone?.();
    },
    onError: (err) => {
      toast.error(resolveFileRootErrorMessage(err, fallbackMessage));
    },
  });
}

export function useFileRootToggleMutation(
  client: ApiClient,
  handlers: FileRootMutationHandlers = {}
) {
  const { t } = useTranslation();
  return useFileRootMutation<{ id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      updateFileRoot(id, { enabled } satisfies UpdateFileRootRequest, client),
    fallbackMessage: t('settings.files.toggleFailed'),
    notifySuccess: false,
    handlers,
  });
}

export function useFileRootDeleteMutation(
  client: ApiClient,
  handlers: FileRootMutationHandlers = {}
) {
  const { t } = useTranslation();
  return useFileRootMutation<string>({
    mutationFn: (id) => deleteFileRoot(id, client),
    fallbackMessage: t('settings.files.deleteFailed'),
    notifySuccess: true,
    handlers,
  });
}

export interface FileRootSaveInput {
  deviceId: string;
  path: string;
  enabled: boolean;
}

export interface FileRootSaveParams {
  /** 缺省表示新增模式 */
  root?: FileRootDto;
  /** 编辑模式下该 root 的来源 client；缺省用 runtime 的 apiClient */
  editClient?: ApiClient;
  deviceGroups?: FileRootDeviceGroup[];
  handlers?: FileRootMutationHandlers;
}

export function useFileRootSaveMutation({
  root,
  editClient,
  deviceGroups,
  handlers = {},
}: FileRootSaveParams) {
  const { t } = useTranslation();
  const { apiClient } = useRuntime();
  return useFileRootMutation<FileRootSaveInput>({
    mutationFn: ({ deviceId, path, enabled }) => {
      if (root) {
        const payload: UpdateFileRootRequest = { path, enabled };
        return updateFileRoot(root.id, payload, editClient ?? apiClient);
      }
      const payload: CreateFileRootRequest = { deviceId, path, enabled };
      return createFileRoot(payload, resolveFileRootClient(deviceGroups, apiClient, deviceId));
    },
    fallbackMessage: root ? t('settings.files.updateFailed') : t('settings.files.addFailed'),
    notifySuccess: true,
    handlers,
  });
}
