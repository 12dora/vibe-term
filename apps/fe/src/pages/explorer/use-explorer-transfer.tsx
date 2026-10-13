// 文件管理器的跨位置传输执行器：粘贴 / 拖放到别的目录或标签页时由宿主统一落地。
// 同节点同设备走 `/api/files/move`；其余走节点间传输任务（字节不经浏览器），进度进共享的
// 传输 store，收尾由 `use-explorer-transfer-watch.ts` 负责。

import { nodeQueryClient } from '@/node/node-runtimes';
import { createNodeApiClient, fetchFileRoots, moveFiles } from '@vibeterm/api-client';
import type { ExplorerDragPayload, ExplorerTransferRequest } from '@vibeterm/panels/explorer';
import { transferJobKey } from '@vibeterm/panels/files/transfers';
import type {
  ListFileRootsResponse,
  ListFilesResponse,
  MoveFilesRequest,
  MoveFilesResponse,
} from '@vibeterm/shared';
import type { AppRuntime, ExplorerTab } from '@vibeterm/stores';
import { useRuntime } from '@vibeterm/stores/react';
import type { TFunction } from 'i18next';
import {
  type ReactElement,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { DialogNodeOption } from '../devices/dialog-nodes';
import {
  sendTransfer,
  transferErrorKey,
  transferErrorKeyOf,
} from '../devices/transfer/send-transfer';
import { type ConflictAnswer, useConflictPrompt } from './explorer-conflict-dialog';
import { useExplorerNodes } from './explorer-nodes';
import {
  type CopyPlanParams,
  conflictingNames,
  fileRequestErrorKey,
  moveFailureToast,
  planTransfer,
  relocatedMoveItems,
  resolveCopyParams,
  tabDropDest,
  transferRequestKey,
} from './explorer-transfer-plan';
import { registerExplorerTransfer } from './use-explorer-transfer-watch';

export interface ExplorerTransferActions {
  run(request: ExplorerTransferRequest): void;
  /** 载荷放到标签页头上：目标是该标签页的**当前**目录（目标设备从那个节点的文件根里解析）。 */
  dropOnTab(payload: ExplorerDragPayload, tab: ExplorerTab, copyModifier: boolean): void;
}

const FILE_ROOTS_KEY = ['files', 'roots'] as const;
const ROOTS_STALE_MS = 30_000;

function listingKey(rootId: string, dir: string) {
  return ['files', 'list', rootId, dir] as const;
}

// 执行器是一次建好的稳定对象，读这些「会变的东西」一律走 ref。
interface ExecutorDeps {
  t: TFunction;
  ask: (names: string[]) => Promise<ConflictAnswer>;
  find: (nodeId: string) => DialogNodeOption | undefined;
  explorer: AppRuntime['stores']['explorer'];
}

function afterMove(
  deps: ExecutorDeps,
  request: ExplorerTransferRequest,
  body: MoveFilesRequest,
  res: MoveFilesResponse
): void {
  const nodeId = request.dest.nodeId;
  const client = nodeQueryClient(nodeId);
  const destRootId = body.destRootId ?? body.rootId;
  void client.invalidateQueries({ queryKey: listingKey(body.rootId, request.source.dir) });
  void client.invalidateQueries({ queryKey: listingKey(destRootId, body.destDir) });

  const roots = client.getQueryData<ListFileRootsResponse>(FILE_ROOTS_KEY)?.roots;
  const rootPath = roots?.find((root) => root.id === body.rootId)?.path;
  if (rootPath === undefined) return;
  // 跨 root 的移动对源 root 的标签页而言等同于删除
  const sameRoot = destRootId === body.rootId;
  const { rebasePath } = deps.explorer.getState();
  for (const { from, to } of relocatedMoveItems(res.results)) {
    rebasePath(nodeId, body.rootId, from, sameRoot ? to : null, rootPath);
  }
}

/** 返回「是否已受理」：请求成功且至少有一项真的移走了。 */
async function executeMove(
  deps: ExecutorDeps,
  request: ExplorerTransferRequest,
  body: MoveFilesRequest
): Promise<boolean> {
  let res: MoveFilesResponse;
  try {
    res = await moveFiles(body, createNodeApiClient(request.dest.nodeId));
  } catch (error) {
    toast.error(deps.t('files.ops.moveFailed'), {
      description: deps.t(fileRequestErrorKey(error)),
    });
    return false;
  }
  afterMove(deps, request, body, res);
  const failure = moveFailureToast(res.results);
  if (failure?.descriptionKey) {
    toast.error(deps.t(failure.key), { description: deps.t(failure.descriptionKey) });
  } else if (failure) {
    toast.error(deps.t(failure.key, { count: failure.count }));
  }
  return res.results.some((item) => item.ok);
}

async function executeCopy(
  deps: ExecutorDeps,
  request: ExplorerTransferRequest,
  params: CopyPlanParams
): Promise<boolean> {
  const sourceNode = deps.find(params.source.nodeId);
  const destNode = deps.find(params.dest.nodeId);
  if (!sourceNode?.usable || !destNode?.usable) {
    toast.error(deps.t(transferErrorKey('node_unreachable')));
    return false;
  }
  try {
    const job = await sendTransfer(resolveCopyParams(params, sourceNode.meshId, destNode.meshId));
    registerExplorerTransfer(transferJobKey(params.source.nodeId, job.jobId), {
      destNodeId: params.dest.nodeId,
      destRootId: params.dest.rootId,
      destDir: params.dest.path,
      count: request.source.paths.length,
    });
    return true;
  } catch (error) {
    toast.error(deps.t(transferErrorKeyOf(error)));
    return false;
  }
}

async function execute(deps: ExecutorDeps, request: ExplorerTransferRequest): Promise<void> {
  const conflicts = conflictingNames(request);
  const answer = conflicts.length > 0 ? await deps.ask(conflicts) : null;
  if (answer === 'cancel') return;

  const plan = planTransfer(request, answer);
  if (plan.kind === 'noop') return;
  const accepted =
    plan.kind === 'move'
      ? await executeMove(deps, request, plan.body)
      : await executeCopy(deps, request, plan.params);
  if (accepted && request.cut) deps.explorer.getState().setClipboard(null);
}

async function requestForTabDrop(
  payload: ExplorerDragPayload,
  tab: ExplorerTab,
  copyModifier: boolean
): Promise<ExplorerTransferRequest | null> {
  const queryClient = nodeQueryClient(tab.nodeId);
  const { roots } = await queryClient.fetchQuery({
    queryKey: FILE_ROOTS_KEY,
    queryFn: () => fetchFileRoots(createNodeApiClient(tab.nodeId)),
    staleTime: ROOTS_STALE_MS,
  });
  const dest = tabDropDest(tab, roots);
  if (!dest) return null;
  // 模型函数随文件管理器面板的 chunk 到货（能拖就说明它已经在了），不把整块面板拉进页面壳
  const { resolveDropKind } = await import('@vibeterm/panels/explorer');
  const kind = resolveDropKind(payload, dest, copyModifier);
  if (kind === 'none') return null;
  const listing = queryClient.getQueryData<ListFilesResponse>(listingKey(dest.rootId, dest.dir));
  const destNames = listing ? new Set(listing.entries.map((entry) => entry.name)) : null;
  return { source: payload, dest, kind, destNames };
}

function createExecutor(depsRef: { current: ExecutorDeps }): ExplorerTransferActions {
  const inFlight = new Set<string>();

  const run = (request: ExplorerTransferRequest) => {
    const key = transferRequestKey(request);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    void execute(depsRef.current, request).finally(() => inFlight.delete(key));
  };

  const dropOnTab: ExplorerTransferActions['dropOnTab'] = (payload, tab, copyModifier) => {
    void requestForTabDrop(payload, tab, copyModifier).then(
      (request) => {
        if (request) run(request);
      },
      (error: unknown) => {
        toast.error(depsRef.current.t(fileRequestErrorKey(error)));
      }
    );
  };

  return { run, dropOnTab };
}

const ExplorerTransferContext = createContext<ExplorerTransferActions | null>(null);

export function ExplorerTransferProvider({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const { find } = useExplorerNodes();
  const prompt = useConflictPrompt();

  const explorer = runtime.stores.explorer;
  const depsRef = useRef<ExecutorDeps>({ t, ask: prompt.ask, find, explorer });
  useEffect(() => {
    depsRef.current = { t, ask: prompt.ask, find, explorer };
  }, [t, prompt.ask, find, explorer]);

  const actions = useMemo(() => createExecutor(depsRef), []);

  return (
    <ExplorerTransferContext.Provider value={actions}>
      {children}
      {prompt.element}
    </ExplorerTransferContext.Provider>
  );
}

export function useExplorerTransferActions(): ExplorerTransferActions {
  const actions = useContext(ExplorerTransferContext);
  if (!actions) {
    throw new Error('useExplorerTransferActions must be used within <ExplorerTransferProvider>');
  }
  return actions;
}
