// 登录历史的跨节点编排：逐台拉取 / 清空 / 改保留时间，单台失败只摘掉那一台并记下原因。
// 与请求本身之间隔一层 `LoginHistoryIo`，单测注入假 IO，不碰网络。

import { createNodeApiClient } from '@vibeterm/api-client';
import {
  clearLoginRecords,
  getLoginRecordSettings,
  listLoginRecords,
  putLoginRecordSettings,
} from '@vibeterm/api-client/auth/index';
import type {
  LoginRecord,
  LoginRecordCursor,
  LoginRecordRetentionDays,
  LoginRecordSettings,
  LoginRecordsClearResult,
  LoginRecordsPage,
} from '@vibeterm/shared';
import {
  type LoginHistoryNode,
  type LoginHistorySkip,
  classifyLoginHistoryError,
} from './login-history-nodes';

export type LoginHistoryOutcome = 'success' | 'failed';

export interface LoginHistoryQuery {
  outcome: LoginHistoryOutcome;
  /** 成功页才有意义：`false` 只看交互式登录。 */
  includeBackground: boolean;
}

export const LOGIN_HISTORY_PAGE_SIZE = 200;
export const LOGIN_HISTORY_CONCURRENCY = 4;

export interface LoginHistoryIo {
  list(
    node: LoginHistoryNode,
    query: LoginHistoryQuery,
    before: LoginRecordCursor | null,
    signal?: AbortSignal
  ): Promise<LoginRecordsPage>;
  clear(node: LoginHistoryNode): Promise<LoginRecordsClearResult>;
  getSettings(node: LoginHistoryNode): Promise<LoginRecordSettings>;
  putSettings(node: LoginHistoryNode, settings: LoginRecordSettings): Promise<LoginRecordSettings>;
}

export const defaultLoginHistoryIo: LoginHistoryIo = {
  list: (node, query, before, signal) =>
    listLoginRecords(
      createNodeApiClient(node.id),
      {
        outcome: query.outcome,
        kind: query.outcome === 'success' && !query.includeBackground ? 'interactive' : 'all',
        limit: LOGIN_HISTORY_PAGE_SIZE,
        ...(before === null ? {} : { before }),
      },
      signal
    ),
  clear: (node) => clearLoginRecords(createNodeApiClient(node.id)),
  getSettings: (node) => getLoginRecordSettings(createNodeApiClient(node.id)),
  putSettings: (node, settings) => putLoginRecordSettings(createNodeApiClient(node.id), settings),
};

export interface LoginHistoryRow extends LoginRecord {
  /** 提供这次登录的节点（记录存放处）。 */
  node: LoginHistoryNode;
  rowKey: string;
}

export interface NodePage {
  records: LoginRecord[];
  /** 下一页游标的时间；与 `nextBeforeId` 都有值才算还有下一页（见 `cursorsOf`）。 */
  nextBefore: number | null;
  nextBeforeId?: string | null;
}

/** 按输入顺序收结果的有界并发：完成次序不影响汇总。 */
export async function forEachNode<T>(
  nodes: readonly LoginHistoryNode[],
  run: (node: LoginHistoryNode) => Promise<T>,
  concurrency = LOGIN_HISTORY_CONCURRENCY
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const results = new Array<{ ok: true; value: T } | { ok: false; error: unknown }>(nodes.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      const node = nodes[index];
      if (!node) return;
      try {
        results[index] = { ok: true, value: await run(node) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
  return results;
}

export interface LoginHistoryFetch {
  pages: Map<string, NodePage>;
  failed: LoginHistorySkip[];
}

/** 拉一页：`cursors` 缺省即首页；给了就只拉其中有下一页的节点。 */
export async function fetchLoginHistory(
  nodes: readonly LoginHistoryNode[],
  query: LoginHistoryQuery,
  io: LoginHistoryIo,
  opts: { cursors?: ReadonlyMap<string, LoginRecordCursor>; signal?: AbortSignal } = {}
): Promise<LoginHistoryFetch> {
  const cursors = opts.cursors;
  const targets = cursors ? nodes.filter((node) => cursors.has(node.id)) : [...nodes];
  const results = await forEachNode(targets, (node) =>
    io.list(node, query, cursors?.get(node.id) ?? null, opts.signal)
  );
  const out: LoginHistoryFetch = { pages: new Map(), failed: [] };
  targets.forEach((node, index) => {
    const result = results[index];
    if (result?.ok) {
      const cursor = result.value.nextBefore;
      out.pages.set(node.id, {
        records: result.value.records ?? [],
        nextBefore: cursor?.at ?? null,
        nextBeforeId: cursor?.id ?? null,
      });
    } else {
      out.failed.push({ node, reason: classifyLoginHistoryError(result?.error) });
    }
  });
  return out;
}

/**
 * 追加下一页：同一节点的记录接在后面，游标换成新的。这一页拉失败的节点摘掉游标——
 * 否则「加载更多」会一直对它重试、每次再记一遍失败；要重来走整体重新加载。
 */
export function appendPages(
  current: ReadonlyMap<string, NodePage>,
  more: ReadonlyMap<string, NodePage>,
  failed: readonly LoginHistorySkip[] = []
): Map<string, NodePage> {
  const merged = new Map(current);
  for (const [nodeId, page] of more) {
    const previous = merged.get(nodeId);
    merged.set(nodeId, {
      records: [...(previous?.records ?? []), ...page.records],
      nextBefore: page.nextBefore,
      nextBeforeId: page.nextBeforeId ?? null,
    });
  }
  for (const skip of failed) {
    const previous = merged.get(skip.node.id);
    if (previous) merged.set(skip.node.id, { ...previous, nextBefore: null, nextBeforeId: null });
  }
  return merged;
}

/** 失败节点并进已有列表：同一台只记一次（以最新一次的原因为准）。 */
export function mergeFailedNodes(
  current: readonly LoginHistorySkip[],
  more: readonly LoginHistorySkip[]
): LoginHistorySkip[] {
  if (more.length === 0) return [...current];
  const replaced = new Set(more.map((skip) => skip.node.id));
  return [...current.filter((skip) => !replaced.has(skip.node.id)), ...more];
}

export function cursorsOf(pages: ReadonlyMap<string, NodePage>): Map<string, LoginRecordCursor> {
  const cursors = new Map<string, LoginRecordCursor>();
  for (const [nodeId, page] of pages) {
    if (page.nextBefore !== null && page.nextBeforeId) {
      cursors.set(nodeId, { at: page.nextBefore, id: page.nextBeforeId });
    }
  }
  return cursors;
}

/**
 * 合并后能放心展示到哪一刻：还有下一页的节点（与「加载更多」同一口径，见 `cursorsOf`）里，
 * 游标最新的那一台之前的记录都可能还没拉到。
 * 比它更早的行先压着，等那台的下一页到了再放出来，否则一台忙节点的最新 200 条后面会直接
 * 接上安静节点几周前的记录，中间整段空白看不出来。
 */
export function loginHistoryWatermark(pages: ReadonlyMap<string, NodePage>): number {
  let watermark = Number.NEGATIVE_INFINITY;
  for (const cursor of cursorsOf(pages).values()) {
    if (cursor.at > watermark) watermark = cursor.at;
  }
  return watermark;
}

/** 各节点的记录合成一张表，按时间倒序；同一时刻按节点顺序稳定排列；早于水位的行暂不展示。 */
export function mergeLoginHistoryRows(
  nodes: readonly LoginHistoryNode[],
  pages: ReadonlyMap<string, NodePage>
): LoginHistoryRow[] {
  const watermark = loginHistoryWatermark(pages);
  const rows: LoginHistoryRow[] = [];
  for (const node of nodes) {
    for (const record of pages.get(node.id)?.records ?? []) {
      if (record.at < watermark) continue;
      rows.push({ ...record, node, rowKey: `${node.id}:${record.id}` });
    }
  }
  return rows.sort((a, b) => b.at - a.at);
}

export interface LoginHistoryBatchResult {
  done: LoginHistoryNode[];
  failed: LoginHistorySkip[];
  /** 清空时各节点删掉的条数之和；改保留时间时为 0。 */
  deleted: number;
}

export async function clearLoginHistory(
  nodes: readonly LoginHistoryNode[],
  io: LoginHistoryIo
): Promise<LoginHistoryBatchResult> {
  const results = await forEachNode(nodes, (node) => io.clear(node));
  return collectBatch(nodes, results, (value) => value.deleted ?? 0);
}

export async function applyLoginHistoryRetention(
  nodes: readonly LoginHistoryNode[],
  retentionDays: number,
  io: LoginHistoryIo
): Promise<LoginHistoryBatchResult> {
  const results = await forEachNode(nodes, (node) =>
    io.putSettings(node, { retentionDays: retentionDays as LoginRecordRetentionDays })
  );
  return collectBatch(nodes, results, () => 0);
}

function collectBatch<T>(
  nodes: readonly LoginHistoryNode[],
  results: Array<{ ok: true; value: T } | { ok: false; error: unknown }>,
  count: (value: T) => number
): LoginHistoryBatchResult {
  const out: LoginHistoryBatchResult = { done: [], failed: [], deleted: 0 };
  nodes.forEach((node, index) => {
    const result = results[index];
    if (result?.ok) {
      out.done.push(node);
      out.deleted += count(result.value);
    } else {
      out.failed.push({ node, reason: classifyLoginHistoryError(result?.error) });
    }
  });
  return out;
}

/**
 * 保留时间下拉框显示的值：各节点一致才有值；不一致或一台都没读到为 `null`，
 * 此时下拉框显示「各节点不同」，选一个就统一写下去。
 */
export async function readLoginHistoryRetention(
  nodes: readonly LoginHistoryNode[],
  io: LoginHistoryIo
): Promise<number | null> {
  const results = await forEachNode(nodes, (node) => io.getSettings(node));
  const values = new Set<number>();
  for (const result of results) if (result?.ok) values.add(result.value.retentionDays);
  return values.size === 1 ? [...values][0] : null;
}
