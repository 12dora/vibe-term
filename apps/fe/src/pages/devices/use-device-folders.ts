// 设备管理页文件夹布局的数据层。
//
// 这些请求**只打 self 节点**（提供 UI 的那台机器自己的库），所以必须在 DevicesPage 顶层的
// runtime 下调用，不能挂到远端 node 的 NodeRuntimeScope 里。
// 移动与排序统一走 `PUT /api/device-folders/layout`：新布局由 `@tmex/shared` 的纯函数算出，
// 乐观写进 query cache，失败整份回滚；上一次提交在飞时禁用拖拽（`pending`）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDeviceFolder,
  deleteDeviceFolder,
  deviceFoldersQueryKey,
  fetchDeviceFolderLayout,
  replaceDeviceFolderLayout,
  updateDeviceFolder,
} from '@tmex/api-client';
import {
  type DeviceFolderItemRef,
  type DeviceFolderLayout,
  type UpdateDeviceFolderLayoutRequest,
  removeItemFromLayout,
  reparentOnFolderDelete,
} from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const EMPTY_LAYOUT: DeviceFolderLayout = { folders: [], placements: [] };

export function toLayoutRequest(layout: DeviceFolderLayout): UpdateDeviceFolderLayoutRequest {
  return {
    folders: layout.folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      sortOrder: folder.sortOrder,
    })),
    placements: layout.placements,
  };
}

export interface DeviceFoldersApi {
  layout: DeviceFolderLayout;
  isLoading: boolean;
  isError: boolean;
  /** 上一次布局提交还在飞 */
  pending: boolean;
  /** 提交一份算好的新布局；null（非法落点）直接忽略 */
  submitLayout: (next: DeviceFolderLayout | null) => void;
  moveItemToRoot: (item: DeviceFolderItemRef) => void;
  createFolder: (name: string, parentId: string | null) => void;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  refetch: () => void;
}

export function useDeviceFolders(): DeviceFoldersApi {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: deviceFoldersQueryKey,
    queryFn: () => fetchDeviceFolderLayout(runtime.apiClient),
    throwOnError: false,
  });
  // 布局没取到（首次加载中 / 失败）时只能展示空树，绝不能据此写回：
  // 服务端可能有根层 placement，整表替换会把它们抹掉。
  const ready = query.data !== undefined;
  const layout = query.data ?? EMPTY_LAYOUT;

  const replaceLayout = useMutation({
    mutationFn: (next: DeviceFolderLayout) =>
      replaceDeviceFolderLayout(
        toLayoutRequest(next),
        t('devices.folders.moveFailed'),
        runtime.apiClient
      ),
    onMutate: async (next: DeviceFolderLayout) => {
      await queryClient.cancelQueries({ queryKey: deviceFoldersQueryKey });
      const previous = queryClient.getQueryData<DeviceFolderLayout>(deviceFoldersQueryKey);
      queryClient.setQueryData(deviceFoldersQueryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(deviceFoldersQueryKey, context.previous);
      else void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
      toast.error(t('devices.folders.moveFailed'));
    },
    onSuccess: (result) => {
      queryClient.setQueryData(deviceFoldersQueryKey, result);
    },
  });

  const createMutation = useMutation({
    mutationFn: (variables: { name: string; parentId: string | null }) =>
      createDeviceFolder(
        { name: variables.name, parentId: variables.parentId },
        t('devices.folders.createFailed'),
        runtime.apiClient
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t('devices.folders.createFailed'));
    },
  });

  const renameMutation = useMutation({
    mutationFn: (variables: { folderId: string; name: string }) =>
      updateDeviceFolder(
        variables.folderId,
        { name: variables.name },
        t('devices.folders.renameFailed'),
        runtime.apiClient
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t('devices.folders.renameFailed'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (folderId: string) =>
      deleteDeviceFolder(folderId, t('devices.folders.deleteFailed'), runtime.apiClient),
    // 服务端同样把子项上提到父级，乐观结果与之一致
    onMutate: async (folderId: string) => {
      await queryClient.cancelQueries({ queryKey: deviceFoldersQueryKey });
      const previous = queryClient.getQueryData<DeviceFolderLayout>(deviceFoldersQueryKey);
      if (previous) {
        queryClient.setQueryData(deviceFoldersQueryKey, reparentOnFolderDelete(previous, folderId));
      }
      return { previous };
    },
    onError: (error, _folderId, context) => {
      if (context?.previous) queryClient.setQueryData(deviceFoldersQueryKey, context.previous);
      toast.error(error instanceof Error ? error.message : t('devices.folders.deleteFailed'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
    },
  });

  // 整表替换必须串行：上一份还在飞时再提交，先发后到的旧布局会覆盖新布局；
  // 这里直接拒绝（拖拽与菜单入口在 pending 期间同样被禁用）。
  const replaceMutate = replaceLayout.mutate;
  const replacePending = replaceLayout.isPending;
  const submitLayout = useCallback(
    (next: DeviceFolderLayout | null) => {
      if (!next || !ready || replacePending) return;
      replaceMutate(next);
    },
    [replaceMutate, ready, replacePending]
  );

  const moveItemToRoot = useCallback(
    (item: DeviceFolderItemRef) => submitLayout(removeItemFromLayout(layout, item)),
    [layout, submitLayout]
  );

  const createMutate = createMutation.mutate;
  const createFolder = useCallback(
    (name: string, parentId: string | null) => createMutate({ name, parentId }),
    [createMutate]
  );

  const renameMutate = renameMutation.mutate;
  const renameFolder = useCallback(
    (folderId: string, name: string) => renameMutate({ folderId, name }),
    [renameMutate]
  );

  const deleteMutate = deleteMutation.mutate;
  const deleteFolder = useCallback((folderId: string) => deleteMutate(folderId), [deleteMutate]);

  const refetchQuery = query.refetch;
  const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

  return {
    layout,
    isLoading: query.isLoading,
    isError: query.isError,
    pending: !ready || replaceLayout.isPending,
    submitLayout,
    moveItemToRoot,
    createFolder,
    renameFolder,
    deleteFolder,
    refetch,
  };
}
