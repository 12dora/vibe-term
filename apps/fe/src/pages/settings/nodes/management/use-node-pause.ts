// 节点暂停 / 恢复：entry 本机偏好，POST 成功后刷新列表。
//
// AuthApi.pauseNode / resumeNode 由 api-client 包提供；本包编译时若尚未导出，
// 退回与升级钩子相同的 `defaultApiClient.fetch`。

import { isMeshNodePaused } from '@/node/merge-nodes';
import type { NodeRow } from '@/node/mesh-nodes';
import { refreshMeshNodes, setNodePaused } from '@/node/mesh-nodes-store';
import { defaultApiClient } from '@vibeterm/api-client';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { errorMessage } from '@vibeterm/shared';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

export type PauseAction = 'pause' | 'resume';

type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

type PauseMethods = {
  pauseNode?: (id: string) => Promise<unknown>;
  resumeNode?: (id: string) => Promise<unknown>;
};

export interface PauseIo {
  post(nodeId: string, action: PauseAction): Promise<void>;
}

async function readError(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown; message?: unknown };
    if (typeof payload.code === 'string' && payload.code) return payload.code;
    if (typeof payload.error === 'string' && payload.error) return payload.error;
    if (typeof payload.message === 'string' && payload.message) return payload.message;
  } catch {
    // 落到 HTTP 状态
  }
  return `HTTP ${res.status}`;
}

function namedPauseMethod(
  api: PauseMethods,
  action: PauseAction
): ((id: string) => Promise<unknown>) | undefined {
  const fn = action === 'pause' ? api.pauseNode : api.resumeNode;
  return typeof fn === 'function' ? fn.bind(api) : undefined;
}

export function createPauseIo(
  api: PauseMethods | object = defaultAuthApi,
  fetchImpl: FetchLike = (path, init) => defaultApiClient.fetch(path, init)
): PauseIo {
  return {
    async post(nodeId, action) {
      const named = namedPauseMethod(api as PauseMethods, action);
      if (named) {
        await named(nodeId);
        return;
      }
      const res = await fetchImpl(`/api/mesh/nodes/${nodeId}/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(await readError(res));
    },
  };
}

export const defaultPauseIo: PauseIo = createPauseIo();

export function pauseErrorText(
  t: (key: string, options?: Record<string, unknown>) => string,
  err: unknown
): string {
  const raw = errorMessage(err);
  if (raw.includes('CANNOT_PAUSE_HUB')) return t('nodes.pause.hubBlocked');
  if (raw.includes('CANNOT_PAUSE_SELF')) return t('nodes.pause.selfBlocked');
  return t('nodes.pause.failed', { error: raw });
}

export async function applyNodePause(
  row: Pick<NodeRow, 'id' | 'paused'>,
  paused: boolean,
  io: PauseIo,
  refresh: () => void = () => refreshMeshNodes()
): Promise<void> {
  setNodePaused(row.id, paused);
  try {
    await io.post(row.id, paused ? 'pause' : 'resume');
    refresh();
  } catch (err) {
    setNodePaused(row.id, isMeshNodePaused(row));
    throw err;
  }
}

export async function toggleNodePause(
  row: Pick<NodeRow, 'id' | 'paused'>,
  io: PauseIo,
  refresh: () => void = () => refreshMeshNodes()
): Promise<void> {
  await applyNodePause(row, !isMeshNodePaused(row), io, refresh);
}

export async function runPauseBatch(
  rows: readonly Pick<NodeRow, 'id' | 'paused'>[],
  action: PauseAction,
  io: PauseIo,
  refresh: () => void = () => refreshMeshNodes()
): Promise<{ failed: number; succeeded: number }> {
  let failed = 0;
  let succeeded = 0;
  const paused = action === 'pause';
  for (const row of rows) {
    try {
      await applyNodePause(row, paused, io, () => undefined);
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }
  refresh();
  return { failed, succeeded };
}

export function useNodePause(row: NodeRow, onChanged: () => void, io: PauseIo = defaultPauseIo) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const paused = isMeshNodePaused(row);

  const toggle = useCallback(async () => {
    if (row.isSelf || row.pending || row.isHub || busy) return;
    setBusy(true);
    try {
      await toggleNodePause(row, io, onChanged);
    } catch (err) {
      toast.error(pauseErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }, [busy, io, onChanged, row, t]);

  return { busy, paused, toggle };
}
