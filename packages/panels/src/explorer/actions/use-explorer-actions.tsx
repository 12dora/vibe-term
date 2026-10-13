// 一个标签页的文件动作：下载（单文件应用内 / 其余打包）、上传（文件、文件夹、拖入）、复制路径。
// 必须挂在该 node 的运行时下。

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileEntryDto, FileRootDto, SystemInfo } from '@vibeterm/shared';
import { useRuntime } from '@vibeterm/stores/react';
import { type ChangeEvent, type ReactElement, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { nodeBasename } from '../../files/file-tree-logic';
import {
  FolderUploadLimitError,
  type FolderUploadPlan,
  collectDroppedItems,
  filesFromDirectoryInput,
} from './folder-upload';
import {
  type TransferFlowDeps,
  downloadArchive,
  downloadSingleFile,
  invalidateListing,
  uploadFilesInto,
  uploadPlanInto,
} from './transfer-flows';

const DEFAULT_TRANSFER_MAX_BYTES = 2 * 1024 * 1024 * 1024;

// React 的 input 类型里没有这两个非标准属性；以展开的方式下发，原样落到 DOM 上
const DIRECTORY_INPUT_ATTRS: Record<string, string> = { webkitdirectory: '', directory: '' };

export interface ExplorerActionContext {
  rootId: string;
  root: FileRootDto;
  dir: string;
  entries: readonly FileEntryDto[];
}

export interface ExplorerActions {
  download(entries: readonly FileEntryDto[]): void;
  uploadFiles(files: File[], destDir: string): Promise<void>;
  uploadDataTransfer(dt: DataTransfer, destDir: string): Promise<void>;
  openFilePicker(destDir: string, opts?: { directory?: boolean }): void;
  copyPath(entry: FileEntryDto): void;
}

/** 与侧栏文件树共用 `['system','info']` 缓存 */
function useTransferMaxBytes(): number {
  const { apiClient } = useRuntime();
  const systemInfoQuery = useQuery({
    queryKey: ['system', 'info'],
    queryFn: async () => {
      const res = await apiClient.fetch('/api/system/info');
      if (!res.ok) throw new Error('system');
      return (await res.json()) as SystemInfo;
    },
    throwOnError: false,
    refetchOnWindowFocus: false,
  });
  return systemInfoQuery.data?.transferMaxBytes ?? DEFAULT_TRANSFER_MAX_BYTES;
}

async function runPlanUpload(
  deps: TransferFlowDeps,
  pending: Promise<FolderUploadPlan> | FolderUploadPlan,
  destDir: string
): Promise<void> {
  let plan: FolderUploadPlan;
  try {
    plan = await pending;
  } catch (error) {
    // 超限时报出是哪个文件夹；其它读取失败拿不到名字，退回目标目录名
    const name = error instanceof FolderUploadLimitError ? error.folderName : nodeBasename(destDir);
    toast.error(deps.t('files.upload.fail', { name }));
    return;
  }
  await uploadPlanInto(deps, plan, destDir);
}

async function copyEntryPath(deps: TransferFlowDeps, entry: FileEntryDto): Promise<void> {
  try {
    await deps.runtime.host.writeClipboardText(entry.path);
    toast.success(deps.t('files.copied'));
  } catch {
    toast.error(deps.t('files.copyFailed'));
  }
}

function buildActions(
  deps: () => TransferFlowDeps,
  openPicker: ExplorerActions['openFilePicker']
): ExplorerActions {
  return {
    download: (entries) => {
      if (entries.length === 0) return;
      const [first] = entries;
      if (entries.length === 1 && first && first.type !== 'dir') {
        void downloadSingleFile(deps(), first);
        return;
      }
      void downloadArchive(deps(), entries);
    },
    uploadFiles: async (files, destDir) => {
      if (files.length === 0) return;
      const current = deps();
      try {
        await uploadFilesInto(current, files, destDir);
      } finally {
        invalidateListing(current, destDir);
      }
    },
    // 不能是 async：collectDroppedItems 必须在 drop 回调的同步阶段抓走 entry
    uploadDataTransfer: (dt, destDir) => runPlanUpload(deps(), collectDroppedItems(dt), destDir),
    openFilePicker: openPicker,
    copyPath: (entry) => void copyEntryPath(deps(), entry),
  };
}

function readDirectoryPlan(fileList: FileList): Promise<FolderUploadPlan> {
  try {
    return Promise.resolve(filesFromDirectoryInput(fileList));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function useExplorerActions(
  ctx: ExplorerActionContext
): ExplorerActions & { fileInputs: ReactElement } {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const transferMaxBytes = useTransferMaxBytes();

  // 动作对象保持稳定引用，每次调用时再读最新依赖
  const depsRef = useRef<TransferFlowDeps | null>(null);
  depsRef.current = { runtime, queryClient, t, rootId: ctx.rootId, transferMaxBytes };
  const fallbackDir = useRef(ctx.dir);
  fallbackDir.current = ctx.dir;

  const filesInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);
  const pickerDestRef = useRef<string | null>(null);

  const actions = useMemo(() => {
    const deps = (): TransferFlowDeps => {
      if (!depsRef.current) throw new Error('explorer actions used before mount');
      return depsRef.current;
    };
    return buildActions(deps, (destDir, opts) => {
      pickerDestRef.current = destDir;
      (opts?.directory ? directoryInputRef : filesInputRef).current?.click();
    });
  }, []);

  const onFilesChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      void actions.uploadFiles(files, pickerDestRef.current ?? fallbackDir.current);
    },
    [actions]
  );

  const onDirectoryChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const deps = depsRef.current;
    const fileList = event.target.files;
    if (!deps || !fileList) return;
    // 先同步读完 FileList 再清空 input：清空会让 FileList 变空
    const pending = readDirectoryPlan(fileList);
    event.target.value = '';
    void runPlanUpload(deps, pending, pickerDestRef.current ?? fallbackDir.current);
  }, []);

  const fileInputs = useMemo(
    () => (
      <>
        <input ref={filesInputRef} type="file" multiple hidden onChange={onFilesChange} />
        <input
          ref={directoryInputRef}
          type="file"
          multiple
          hidden
          onChange={onDirectoryChange}
          {...DIRECTORY_INPUT_ATTRS}
        />
      </>
    ),
    [onFilesChange, onDirectoryChange]
  );

  return useMemo(() => ({ ...actions, fileInputs }), [actions, fileInputs]);
}
