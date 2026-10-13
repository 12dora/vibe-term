// 文件树的文件操作宿主：整棵树只挂一份「名称」对话框与一份「删除确认」，
// 目录行 / 文件行的菜单项经 `useFileOpsRequest()` 投请求过来。

import { useQueryClient } from '@tanstack/react-query';
import type { ListFilesResponse } from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CLOSED_FILE_OPS_STATE,
  type FileOpsRequest,
  type FileOpsRequestApi,
  type FileOpsRequestStore,
  createFileOpsRequestStore,
  listingNames,
  nameRequestDir,
  namesOrEmpty,
} from './file-ops-requests';
import { FileDeleteDialog, FileNameDialog, parentDir, uniqueChildName, useFileOps } from './ops';
import { fileListQueryKey } from './use-directory-listing';

export type { FileOpsEntryRef, FileOpsRequestApi } from './file-ops-requests';

const FileOpsRequestContext = createContext<FileOpsRequestApi | null>(null);

const closedSnapshot = () => CLOSED_FILE_OPS_STATE;

export function FileOpsHostProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createFileOpsRequestStore);
  return (
    <FileOpsRequestContext.Provider value={store}>
      {children}
      <FileOpsDialogs store={store} />
    </FileOpsRequestContext.Provider>
  );
}

export function useFileOpsRequest(): FileOpsRequestApi {
  const api = useContext(FileOpsRequestContext);
  if (!api) throw new Error('useFileOpsRequest must be used within FileOpsHostProvider');
  return api;
}

type NameRequest = Extract<FileOpsRequest, { kind: 'newFolder' | 'rename' }>;
type DeleteRequest = Extract<FileOpsRequest, { kind: 'delete' }>;

function FileOpsDialogs({ store }: { store: FileOpsRequestStore }) {
  const { request, open } = useSyncExternalStore(store.subscribe, store.get, closedSnapshot);
  const nameRequest = request && request.kind !== 'delete' ? request : null;
  const deleteRequest = request?.kind === 'delete' ? request : null;
  return (
    <>
      <NameRequestDialog
        request={nameRequest}
        open={open && nameRequest !== null}
        onClose={store.close}
      />
      <DeleteRequestDialog
        request={deleteRequest}
        open={open && deleteRequest !== null}
        onClose={store.close}
      />
    </>
  );
}

function NameRequestDialog({
  request,
  open,
  onClose,
}: {
  request: NameRequest | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const ops = useFileOps();

  // 只在请求到来时读一次缓存：对话框开着的时候名称集合不该跟着轮询变
  const takenNames = useMemo(() => {
    const dir = nameRequestDir(request, parentDir);
    if (!request || dir === null) return undefined;
    return listingNames(
      queryClient.getQueryData<ListFilesResponse>(fileListQueryKey(request.rootId, dir))
    );
  }, [request, queryClient]);

  const isNewFolder = request?.kind === 'newFolder';
  const initialName =
    request?.kind === 'rename'
      ? request.name
      : uniqueChildName(t('files.ops.defaultFolderName'), namesOrEmpty(takenNames));

  const submit = async (name: string): Promise<boolean> => {
    if (!request) return true;
    if (request.kind === 'rename') {
      if (name === request.name) return true;
      return (await ops.rename(request.rootId, request.path, name)) !== null;
    }
    const created = await ops.createFolder(request.rootId, request.dir, name);
    if (created === null) return false;
    // 展开所在目录，新建的文件夹才看得见
    runtime.stores.fileTree.getState().expand(request.rootId, request.dir);
    return true;
  };

  return (
    <FileNameDialog
      open={open}
      title={t(isNewFolder ? 'files.ops.newFolderTitle' : 'files.ops.renameTitle')}
      confirmLabel={t(isNewFolder ? 'files.ops.create' : 'files.ops.rename')}
      initialName={initialName}
      takenNames={takenNames}
      selectStem={request?.kind === 'rename' && !request.isDir}
      onSubmit={submit}
      onClose={onClose}
    />
  );
}

function DeleteRequestDialog({
  request,
  open,
  onClose,
}: {
  request: DeleteRequest | null;
  open: boolean;
  onClose: () => void;
}) {
  const ops = useFileOps();
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => request?.entries.map((entry) => entry.name) ?? [], [request]);

  const confirm = async () => {
    if (!request || busy) return;
    setBusy(true);
    try {
      // 失败的 Toast 由 useFileOps 负责；无论成败都收起确认框
      await ops.remove(
        request.rootId,
        request.entries.map((entry) => entry.path)
      );
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <FileDeleteDialog
      open={open}
      names={names}
      busy={busy}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  );
}
