// 登录历史对话框的数据层：节点分拣、按页签拉取、加载更多、清空与保留时间。

import { useInventoryReadiness } from '@/node/inventory-readiness';
import { useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { MIN_LOGIN_RECORDS_VERSION } from '@vibeterm/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LoginHistoryBatchResult,
  type LoginHistoryIo,
  type LoginHistoryQuery,
  type LoginHistoryRow,
  type NodePage,
  appendPages,
  applyLoginHistoryRetention,
  clearLoginHistory,
  cursorsOf,
  defaultLoginHistoryIo,
  fetchLoginHistory,
  mergeFailedNodes,
  mergeLoginHistoryRows,
  readLoginHistoryRetention,
} from './login-history-data';
import {
  type LoginHistoryNode,
  type LoginHistoryPlan,
  type LoginHistorySkip,
  planLoginHistoryNodes,
} from './login-history-nodes';

export function useLoginHistoryPlan(enabled: boolean): { plan: LoginHistoryPlan; ready: boolean } {
  const { t } = useTranslation();
  const { meshEnabled, entryNodeId } = useSharedAuthMode();
  const { nodes } = useMeshNodes({ enabled: enabled && meshEnabled });
  const { loading } = useInventoryReadiness();
  const selfName = t('device.addTo.self');
  const plan = useMemo(
    () => planLoginHistoryNodes(nodes, entryNodeId, selfName, MIN_LOGIN_RECORDS_VERSION),
    [nodes, entryNodeId, selfName]
  );
  return { plan, ready: !loading };
}

/** 节点集合的稳定键：列表轮询换了对象但成员没变时不重拉。 */
function targetsKey(targets: readonly LoginHistoryNode[]): string {
  return targets.map((node) => node.id).join(',');
}

export interface LoginHistoryState {
  rows: LoginHistoryRow[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** 本次拉取失败的节点（与计划里跳过的节点合并后显示成标签）。 */
  failed: LoginHistorySkip[];
  loadMore: () => void;
  reload: () => void;
}

export function useLoginHistoryRecords(
  targets: readonly LoginHistoryNode[],
  query: LoginHistoryQuery,
  opts: { enabled: boolean; io?: LoginHistoryIo }
): LoginHistoryState {
  const io = opts.io ?? defaultLoginHistoryIo;
  const [pages, setPages] = useState<Map<string, NodePage>>(() => new Map());
  const [failed, setFailed] = useState<LoginHistorySkip[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [generation, setGeneration] = useState(0);
  const key = targetsKey(targets);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const liveRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` 代表节点集合，`generation` 是手动重拉
  useEffect(() => {
    if (!opts.enabled) return;
    const run = ++liveRef.current;
    const controller = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    setPages(new Map());
    setFailed([]);
    void fetchLoginHistory(targetsRef.current, query, io, { signal: controller.signal }).then(
      (out) => {
        if (run !== liveRef.current) return;
        setPages(out.pages);
        setFailed(out.failed);
        setLoading(false);
      }
    );
    return () => {
      controller.abort();
      liveRef.current += 1;
    };
  }, [opts.enabled, key, query.outcome, query.includeBackground, io, generation]);

  const cursors = useMemo(() => cursorsOf(pages), [pages]);

  const loadMore = useCallback(() => {
    if (cursors.size === 0 || loadingMore) return;
    const run = liveRef.current;
    setLoadingMore(true);
    void fetchLoginHistory(targetsRef.current, query, io, { cursors }).then((out) => {
      if (run !== liveRef.current) return;
      setLoadingMore(false);
      setPages((current) => appendPages(current, out.pages, out.failed));
      setFailed((current) => mergeFailedNodes(current, out.failed));
    });
  }, [cursors, io, loadingMore, query]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const rows = useMemo(() => mergeLoginHistoryRows(targetsRef.current, pages), [pages]);

  return {
    rows,
    loading,
    loadingMore,
    hasMore: cursors.size > 0,
    failed,
    loadMore,
    reload,
  };
}

export interface LoginHistoryRetentionState {
  /** 各节点一致时的天数；不一致 / 未读到为 `null`。 */
  value: number | null;
  saving: boolean;
  apply: (retentionDays: number) => Promise<LoginHistoryBatchResult>;
}

export function useLoginHistoryRetention(
  targets: readonly LoginHistoryNode[],
  opts: { enabled: boolean; io?: LoginHistoryIo }
): LoginHistoryRetentionState {
  const io = opts.io ?? defaultLoginHistoryIo;
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const key = targetsKey(targets);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` 代表节点集合
  useEffect(() => {
    if (!opts.enabled) return;
    let alive = true;
    void readLoginHistoryRetention(targetsRef.current, io).then((next) => {
      if (alive) setValue(next);
    });
    return () => {
      alive = false;
    };
  }, [opts.enabled, key, io]);

  const apply = useCallback(
    async (retentionDays: number) => {
      setSaving(true);
      try {
        const result = await applyLoginHistoryRetention(targetsRef.current, retentionDays, io);
        setValue(result.failed.length === 0 ? retentionDays : null);
        return result;
      } finally {
        setSaving(false);
      }
    },
    [io]
  );

  return { value, saving, apply };
}

export function useLoginHistoryClear(
  targets: readonly LoginHistoryNode[],
  io: LoginHistoryIo = defaultLoginHistoryIo
): { clearing: boolean; clear: () => Promise<LoginHistoryBatchResult> } {
  const [clearing, setClearing] = useState(false);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const clear = useCallback(async () => {
    setClearing(true);
    try {
      return await clearLoginHistory(targetsRef.current, io);
    } finally {
      setClearing(false);
    }
  }, [io]);
  return { clearing, clear };
}
