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

// 每条请求各挂一份对话框（key = seq）：忙碌态归这一条请求所有，上一条请求迟到的完成回调
// 既碰不到新对话框的按钮状态，也因为 `closeRequest` 认请求本身而关不掉它。
function FileOpsDialogs({ store }: { store: FileOpsRequestStore }) {
  const { request, open, seq } = useSyncExternalStore(store.subscribe, store.get, closedSnapshot);
  if (!request) return null;
  const onClose = () => store.closeRequest(request);
  return request.kind === 'delete' ? (
    <DeleteRequestDialog key={seq} request={request} open={open} onClose={onClose} />
  ) : (
    <NameRequestDialog key={seq} request={request} open={open} onClose={onClose} />
  );
}

function NameRequestDialog({
  request,
  open,
  onClose,
}: {
  request: NameRequest;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const ops = useFileOps();

  // 只在挂载时读一次缓存：对话框开着的时候名称集合与默认名不该跟着轮询变
  const [{ takenNames, initialName }] = useState(() => {
    const names = listingNames(
      queryClient.getQueryData<ListFilesResponse>(
        fileListQueryKey(request.rootId, nameRequestDir(request, parentDir))
      )
    );
    return {
      takenNames: names,
      initialName:
        request.kind === 'rename'
          ? request.name
          : uniqueChildName(t('files.ops.defaultFolderName'), namesOrEmpty(names)),
    };
  });

  const submit = async (name: string): Promise<boolean> => {
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

  const isNewFolder = request.kind === 'newFolder';
  return (
    <FileNameDialog
      open={open}
      title={t(isNewFolder ? 'files.ops.newFolderTitle' : 'files.ops.renameTitle')}
      confirmLabel={t(isNewFolder ? 'files.ops.create' : 'files.ops.rename')}
      initialName={initialName}
      takenNames={takenNames}
      selectStem={request.kind === 'rename' && !request.isDir}
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
  request: DeleteRequest;
  open: boolean;
  onClose: () => void;
}) {
  const ops = useFileOps();
  const [busy, setBusy] = useState(false);
  const names = useMemo(() => request.entries.map((entry) => entry.name), [request]);

  const confirm = async () => {
    if (busy) return;
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

  // 请求在途时 FileDeleteDialog 自己不再响应取消 / Esc / 点外面（发出去的删除撤不回）
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
