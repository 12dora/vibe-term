// 设备管理页分组布局的数据层。
//
// 这些请求**只打 self 节点**（浏览器直连的那台 entry 自己的库）：分组列表里的节点来自
// entry 级的 mesh 列表（`useMeshNodes`，与路由无关），布局自然也只能是 entry 的。
// 所以这里**不用 `useRuntime()`**——设备页可能挂在 `/n/<nodeId>/devices` 下，那时上下文
// runtime 是远端 node，用它会去读**远端机器自己的**分组布局（页面上会冒出本机没有的分组），
// 写回更会把远端的布局改掉。runtime 与 QueryClient 一律显式取 self 的那份。
// 移动与排序统一走 `PUT /api/device-folders/layout`：新布局由 `@tmex/shared` 的纯函数算出，
// 乐观写进 query cache，失败整份回滚；上一次提交在飞时禁用拖拽（`pending`）。
// 「恢复默认布局」走 `POST /api/device-folders/reset`，服务端一个事务删光分组与 placement。

import { useMutation, useQuery } from '@tanstack/react-query';
import {
  SELF_NODE_ID,
  createDeviceFolder,
  deleteDeviceFolder,
  deviceFoldersQueryKey,
  fetchDeviceFolderLayout,
  replaceDeviceFolderLayout,
  resetDeviceFolderLayout,
  updateDeviceFolder,
} from '@tmex/api-client';
import {
  type DeviceFolderLayout,
  type UpdateDeviceFolderLayoutRequest,
  reparentOnFolderDelete,
} from '@tmex/shared';
import { useNodeRuntime } from '@tmex/stores';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { appNodeRuntimes, nodeQueryClient } from '@/node/node-runtimes';

const EMPTY_LAYOUT: DeviceFolderLayout = { folders: [], placements: [] };

export function toLayoutRequest(layout: DeviceFolderLayout): UpdateDeviceFolderLayoutRequest {
  return {
    folders: layout.folders.map((folder) => ({ id: folder.id, sortOrder: folder.sortOrder })),
    placements: layout.placements,
  };
}

export interface DeviceFoldersApi {
  layout: DeviceFolderLayout;
  isLoading: boolean;
  isError: boolean;
  /** 上一次布局提交还在飞（拖拽禁用） */
  pending: boolean;
  /** 任一布局变更（替换 / 新建 / 重命名 / 删除 / 恢复默认）在飞：互相拒绝，顶栏按钮禁用 */
  layoutBusy: boolean;
  /** 提交一份算好的新布局；null（非法落点）直接忽略 */
  submitLayout: (next: DeviceFolderLayout | null) => void;
  createFolder: (name: string) => void;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  resetLayout: () => void;
  refetch: () => void;
}

export function useDeviceFolders(): DeviceFoldersApi {
  const { t } = useTranslation();
  const runtime = useNodeRuntime(SELF_NODE_ID, appNodeRuntimes);
  const queryClient = nodeQueryClient(SELF_NODE_ID);

  const query = useQuery(
    {
      queryKey: deviceFoldersQueryKey,
      queryFn: () => fetchDeviceFolderLayout(runtime.apiClient),
      throwOnError: false,
    },
    queryClient
  );
  // 布局没取到（首次加载中 / 失败）时只能展示空列表，绝不能据此写回：
  // 服务端可能有根层 placement，整表替换会把它们抹掉。
  const ready = query.data !== undefined;
  const layout = query.data ?? EMPTY_LAYOUT;

  const replaceLayout = useMutation(
    {
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
    },
    queryClient
  );

  const createMutation = useMutation(
    {
      mutationFn: (name: string) =>
        createDeviceFolder({ name }, t('devices.folders.createFailed'), runtime.apiClient),
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
      },
      onError: (error) => {
        toast.error(error instanceof Error ? error.message : t('devices.folders.createFailed'));
      },
    },
    queryClient
  );

  const renameMutation = useMutation(
    {
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
    },
    queryClient
  );

  const deleteMutation = useMutation(
    {
      mutationFn: (folderId: string) =>
        deleteDeviceFolder(folderId, t('devices.folders.deleteFailed'), runtime.apiClient),
      // 服务端同样把其中的节点上提到根层，乐观结果与之一致
      onMutate: async (folderId: string) => {
        await queryClient.cancelQueries({ queryKey: deviceFoldersQueryKey });
        const previous = queryClient.getQueryData<DeviceFolderLayout>(deviceFoldersQueryKey);
        if (previous) {
          queryClient.setQueryData(
            deviceFoldersQueryKey,
            reparentOnFolderDelete(previous, folderId)
          );
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
    },
    queryClient
  );

  const resetMutation = useMutation(
    {
      mutationFn: () =>
        resetDeviceFolderLayout(t('devices.folders.resetFailed'), runtime.apiClient),
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: deviceFoldersQueryKey });
        const previous = queryClient.getQueryData<DeviceFolderLayout>(deviceFoldersQueryKey);
        queryClient.setQueryData(deviceFoldersQueryKey, EMPTY_LAYOUT);
        return { previous };
      },
      onError: (error, _variables, context) => {
        if (context?.previous) queryClient.setQueryData(deviceFoldersQueryKey, context.previous);
        toast.error(error instanceof Error ? error.message : t('devices.folders.resetFailed'));
      },
      onSuccess: (result) => {
        queryClient.setQueryData(deviceFoldersQueryKey, result);
        toast.success(t('devices.folders.resetDone'));
      },
      // 落定后无论成败都以服务端为准再拉一次：晚到的旧 onSuccess 不能把非默认布局留在缓存里
      onSettled: () => {
        void queryClient.invalidateQueries({ queryKey: deviceFoldersQueryKey });
      },
    },
    queryClient
  );

  // 布局变更必须串行：任一在飞时其余一律拒绝（先发后到的旧布局会覆盖新布局；
  // 恢复默认与其它变更并发更会留下半截结果）。拖拽与顶栏按钮在此期间同样禁用。
  const layoutBusy =
    !ready ||
    replaceLayout.isPending ||
    createMutation.isPending ||
    renameMutation.isPending ||
    deleteMutation.isPending ||
    resetMutation.isPending;
  const replaceMutate = replaceLayout.mutate;
  const submitLayout = useCallback(
    (next: DeviceFolderLayout | null) => {
      if (!next || layoutBusy) return;
      replaceMutate(next);
    },
    [replaceMutate, layoutBusy]
  );

  const createMutate = createMutation.mutate;
  const createFolder = useCallback(
    (name: string) => {
      if (layoutBusy) return;
      createMutate(name);
    },
    [createMutate, layoutBusy]
  );

  const renameMutate = renameMutation.mutate;
  const renameFolder = useCallback(
    (folderId: string, name: string) => {
      if (layoutBusy) return;
      renameMutate({ folderId, name });
    },
    [renameMutate, layoutBusy]
  );

  const deleteMutate = deleteMutation.mutate;
  const deleteFolder = useCallback(
    (folderId: string) => {
      if (layoutBusy) return;
      deleteMutate(folderId);
    },
    [deleteMutate, layoutBusy]
  );

  const resetMutate = resetMutation.mutate;
  const resetLayout = useCallback(() => {
    if (layoutBusy) return;
    resetMutate();
  }, [resetMutate, layoutBusy]);

  const refetchQuery = query.refetch;
  const refetch = useCallback(() => void refetchQuery(), [refetchQuery]);

  return {
    layout,
    isLoading: query.isLoading,
    isError: query.isError,
    pending: layoutBusy,
    layoutBusy,
    submitLayout,
    createFolder,
    renameFolder,
    deleteFolder,
    resetLayout,
    refetch,
  };
}
