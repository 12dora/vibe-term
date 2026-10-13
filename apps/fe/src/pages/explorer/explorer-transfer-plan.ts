// 文件管理器跨位置传输的纯决策：重名检测、把一次请求翻成「同设备移动」或「节点间复制」的参数、
// 移动结果该弹哪种 Toast，以及复制任务结束时的归类。不碰网络、不碰 React，全部有单测。

import { FileApiError, isFileRouteUnsupported } from '@vibeterm/api-client';
import type { ExplorerTransferRequest } from '@vibeterm/panels/explorer';
import type { TransferJobView } from '@vibeterm/panels/files/transfers';
import type { FileRootDto, MoveFileItemResult, MoveFilesRequest } from '@vibeterm/shared';
import type { ExplorerClipboard, ExplorerTab } from '@vibeterm/stores';

import type { SendTransferParams } from '../devices/transfer/send-transfer';

export type ConflictDecision = 'replace' | 'skip';

export interface ExplorerDestRef {
  nodeId: string;
  rootId: string;
  deviceId: string;
  dir: string;
}

/** 还没补上 meshId 的复制参数；meshId 要查节点表，由调用方用 `resolveCopyParams` 补齐。 */
export interface CopyPlanParams {
  source: { nodeId: string; rootId: string; path: string; paths: string[] };
  dest: { nodeId: string; rootId: string; path: string };
  onConflict: 'skip' | 'overwrite';
}

export type TransferPlan =
  | { kind: 'move'; body: MoveFilesRequest }
  | { kind: 'copy'; params: CopyPlanParams }
  | { kind: 'noop' };

/** 目标目录里已有的同名项；目标列表未知（`destNames` 为 null）时视为没有。 */
export function conflictingNames(request: ExplorerTransferRequest): string[] {
  const { destNames } = request;
  if (!destNames) return [];
  return request.source.names.filter((name) => destNames.has(name));
}

function movePlan(request: ExplorerTransferRequest, decision: ConflictDecision | null) {
  const { source, dest } = request;
  let paths = source.paths;
  if (decision === 'skip') {
    const conflicts = new Set(conflictingNames(request));
    paths = source.paths.filter((_, index) => !conflicts.has(source.names[index] ?? ''));
  }
  if (paths.length === 0) return { kind: 'noop' } as const;
  const body: MoveFilesRequest = {
    rootId: source.rootId,
    paths: [...paths],
    destRootId: dest.rootId,
    destDir: dest.dir,
    onConflict: decision === 'replace' ? 'overwrite' : 'fail',
  };
  return { kind: 'move', body } as const;
}

export function planTransfer(
  request: ExplorerTransferRequest,
  decision: ConflictDecision | null
): TransferPlan {
  const { source, dest } = request;
  if (source.paths.length === 0) return { kind: 'noop' };
  if (request.kind === 'move') return movePlan(request, decision);
  return {
    kind: 'copy',
    params: {
      source: {
        nodeId: source.nodeId,
        rootId: source.rootId,
        path: source.dir,
        paths: [...source.paths],
      },
      dest: { nodeId: dest.nodeId, rootId: dest.rootId, path: dest.dir },
      onConflict: decision === 'replace' ? 'overwrite' : 'skip',
    },
  };
}

export function resolveCopyParams(
  params: CopyPlanParams,
  sourceMeshId: string,
  destMeshId: string
): SendTransferParams {
  return {
    source: { ...params.source, meshId: sourceMeshId },
    dest: { ...params.dest, meshId: destMeshId },
    onConflict: params.onConflict,
  };
}

/** 标签页当前目录作为放置目标；根已不存在 / 被停用时为 null。 */
export function tabDropDest(
  tab: ExplorerTab,
  roots: readonly FileRootDto[]
): ExplorerDestRef | null {
  const root = roots.find((item) => item.id === tab.rootId);
  const dir = tab.history[tab.index];
  if (!root || !root.enabled || dir === undefined) return null;
  return { nodeId: tab.nodeId, rootId: root.id, deviceId: root.deviceId, dir };
}

/** 同一请求的指纹：在飞期间再次提交同样的请求直接丢弃。 */
export function transferRequestKey(request: ExplorerTransferRequest): string {
  const { source, dest } = request;
  return JSON.stringify([
    request.kind,
    source.nodeId,
    source.rootId,
    source.paths,
    dest.nodeId,
    dest.rootId,
    dest.dir,
  ]);
}

export interface MoveToastSpec {
  key: 'files.ops.moveFailed' | 'files.ops.movePartial';
  count?: number;
  descriptionKey?: string;
}

/** 全失败带首项原因，部分失败只报数量，全成功不弹。 */
export function moveFailureToast(results: readonly MoveFileItemResult[]): MoveToastSpec | null {
  const failed = results.filter((item) => !item.ok);
  if (failed.length === 0) return null;
  if (failed.length < results.length) return { key: 'files.ops.movePartial', count: failed.length };
  return {
    key: 'files.ops.moveFailed',
    descriptionKey: `files.error.${failed[0]?.code ?? 'unknown'}`,
  };
}

/** 真正换了位置的移动项（原地 no-op 不算）。 */
export function relocatedMoveItems(
  results: readonly MoveFileItemResult[]
): Array<{ from: string; to: string }> {
  const moved: Array<{ from: string; to: string }> = [];
  for (const item of results) {
    if (item.ok && item.dest !== undefined && item.dest !== item.path) {
      moved.push({ from: item.path, to: item.dest });
    }
  }
  return moved;
}

/** 请求级失败的原因文案；先判「节点不认识这条路由」，旧节点的 404 可能带非文件业务码。 */
export function fileRequestErrorKey(error: unknown): string {
  if (isFileRouteUnsupported(error)) return 'files.ops.unsupported';
  const code = error instanceof FileApiError ? error.code : undefined;
  return `files.error.${code ?? 'unknown'}`;
}

function sameClipboard(a: ExplorerClipboard, b: ExplorerClipboard): boolean {
  if (a === b) return true;
  if (a.mode !== b.mode || a.nodeId !== b.nodeId || a.rootId !== b.rootId) return false;
  if (a.paths.length !== b.paths.length) return false;
  return a.paths.every((path, index) => path === b.paths[index]);
}

/**
 * 剪切粘贴落定后的剪贴板。`submitted` 是提交那一刻的剪贴板；期间用户换过内容（或它本就不是
 * 剪切）就原样返回 `current`——调用方按引用判断要不要写回。否则只摘掉真正离开原处的路径
 * （因重名被跳过、移动失败的仍留着可以再粘贴），一项不剩时清空。
 */
export function clipboardAfterCut(
  current: ExplorerClipboard | null,
  submitted: ExplorerClipboard | null,
  takenPaths: readonly string[]
): ExplorerClipboard | null {
  if (!current || !submitted || submitted.mode !== 'cut') return current;
  if (!sameClipboard(current, submitted) || takenPaths.length === 0) return current;
  const taken = new Set(takenPaths);
  const paths = current.paths.filter((path) => !taken.has(path));
  if (paths.length === current.paths.length) return current;
  return paths.length === 0 ? null : { ...current, paths };
}

/** 移动结果里成功的源路径（原地 no-op 也算：它已经在目标目录里了）。 */
export function movedSourcePaths(results: readonly MoveFileItemResult[]): string[] {
  return results.filter((item) => item.ok).map((item) => item.path);
}

export type TransferEnd =
  | { kind: 'pending' }
  /** 全部复制完成；`count` 是完成的条目数，条目状态一个都没见过时为 null。 */
  | { kind: 'done'; count: number | null }
  /** 复制了一部分：其余的因目标已存在被跳过（`skipped`），或有条目失败（`failed`）。 */
  | { kind: 'partial'; count: number; rest: 'skipped' | 'failed' }
  /** 任务正常结束，但每一项都因目标已存在被跳过：什么也没复制。 */
  | { kind: 'skipped' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: string | null };

// 任务已落在 done：runner 遇到单项失败会继续往下传，所以既非 skipped 也非 failed 的都算传完了
// （包括事件流里还没见过状态的条目）。
function classifyDone(view: Pick<TransferJobView, 'itemStates' | 'error'>): TransferEnd {
  const total = view.itemStates.length;
  if (total === 0) return { kind: 'done', count: null };
  const failed = view.itemStates.filter((state) => state === 'failed').length;
  const skipped = view.itemStates.filter((state) => state === 'skipped').length;
  const count = total - failed - skipped;
  if (failed === 0 && skipped === 0) return { kind: 'done', count };
  if (count === 0) {
    return failed > 0 ? { kind: 'failed', error: view.error ?? null } : { kind: 'skipped' };
  }
  return { kind: 'partial', count, rest: failed > 0 ? 'failed' : 'skipped' };
}

export function classifyTransferEnd(
  view: Pick<TransferJobView, 'state' | 'itemStates' | 'error'>
): TransferEnd {
  switch (view.state) {
    case 'queued':
    case 'running':
      return { kind: 'pending' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'failed', error: view.error ?? null };
    case 'done':
      return classifyDone(view);
  }
}
