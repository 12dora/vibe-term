// 节点升级：latest 版本查询 + 每节点一份的升级状态机。
//
// 升级由目标节点自己的网关执行，执行阶段它会被替换并重启——轮询打不通目标是**预期现象**，
// 不能当失败。因此状态机的判定链是：
//   POST → 见过非 idle（downloading / executing）→ 掉线 / 回到 idle → 刷新节点列表比版本。
// 只有版本对上（或时间预算内目标重新可达且 latest 未知）才算成功；预算耗尽只提示「未确认」，
// 让用户自己刷新核对，绝不猜一个结论。
//
// POST 一律不重试：目标可能已经开始升级却来不及回包，重发会撞上 `UPGRADE_IN_PROGRESS`。

import { type NodeRow, getMeshNodesState, refreshMeshNodes } from '@/node/mesh-nodes';
import { defaultApiClient } from '@tmex/api-client';
import type { UpgradeStatus } from '@tmex/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  IDLE_UPGRADE_ENTRY,
  type NodeUpgradeController,
  type NodeUpgradeEntry,
  type NodeUpgradeLatest,
  type NodeUpgradePhase,
} from './types';

const POLL_MS = 2000;
/** 下载 + 解包 + 重启 + 版本回传的总预算。 */
const BUDGET_MS = 6 * 60_000;
/** POST 之后目标迟迟不进入非 idle：判定没真正开始，不要空等满预算。 */
const START_GRACE_MS = 30_000;

type Translate = (key: string, options?: Record<string, unknown>) => string;

const ERROR_KEYS: Record<string, string> = {
  NODE_LOGIN_REQUIRED: 'nodes.upgrade.loginRequired',
  NODE_UNREACHABLE: 'nodes.upgrade.unreachable',
  UPGRADE_NOT_ALLOWED: 'nodes.upgrade.notAllowed',
  UPGRADE_IN_PROGRESS: 'nodes.upgrade.inProgress',
  UPGRADE_UNSUPPORTED: 'nodes.upgrade.unsupported',
  RELEASE_UNAVAILABLE: 'nodes.upgrade.releaseUnavailable',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCode(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 落到通用码
  }
  return 'UPGRADE_FAILED';
}

export async function fetchUpgradeLatest(): Promise<NodeUpgradeLatest | null> {
  const res = await defaultApiClient.fetch('/api/mesh/upgrade/latest');
  if (!res.ok) return null;
  const payload = (await res.json()) as Partial<NodeUpgradeLatest>;
  if (typeof payload.latestVersion !== 'string' || !payload.latestVersion) return null;
  return {
    latestVersion: payload.latestVersion,
    changelog: payload.changelog ?? null,
    publishedAt: payload.publishedAt ?? null,
  };
}

type StartResult = { ok: true; status: UpgradeStatus } | { ok: false; code: string };

async function postUpgrade(nodeId: string): Promise<StartResult> {
  const res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) return { ok: false, code: await readCode(res) };
  return { ok: true, status: (await res.json()) as UpgradeStatus };
}

/** 拿不到状态（目标重启中 / 链路断开）返回 `null`，由调用方按「重启中」继续等。 */
async function getUpgradeStatus(nodeId: string): Promise<UpgradeStatus | null> {
  try {
    const res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`);
    if (!res.ok) return null;
    return (await res.json()) as UpgradeStatus;
  } catch {
    return null;
  }
}

/** 刷新节点列表后比对版本：这是升级成功唯一可信的证据（升级状态不跨进程持久化）。 */
async function versionConfirmed(nodeId: string, targetVersion: string | null): Promise<boolean> {
  await refreshMeshNodes();
  const node = getMeshNodesState().nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  // latest 没拿到时无从比对：目标重新可达即视为完成。
  if (!targetVersion) return true;
  return node.version === targetVersion;
}

interface WatchContext {
  nodeId: string;
  targetVersion: string | null;
  sawActive: boolean;
  alive: () => boolean;
  phase: (phase: NodeUpgradePhase) => void;
}

type WatchResult = { kind: 'done' } | { kind: 'failed'; error: string } | { kind: 'timeout' };

async function watchUpgrade(ctx: WatchContext): Promise<WatchResult> {
  const startedAt = Date.now();
  const deadline = startedAt + BUDGET_MS;
  let sawActive = ctx.sawActive;
  while (Date.now() < deadline) {
    await delay(POLL_MS);
    if (!ctx.alive()) return { kind: 'timeout' };
    const status = await getUpgradeStatus(ctx.nodeId);
    if (!status) {
      ctx.phase(sawActive ? 'restarting' : 'pending');
      continue;
    }
    if (status.state !== 'idle') {
      sawActive = true;
      ctx.phase(status.state);
      continue;
    }
    // 状态不跨进程持久化：重启回来后 error 一定是空的，所以 idle 上还挂着 error 就是下载阶段失败。
    if (status.error) return { kind: 'failed', error: status.error };
    if (!sawActive) {
      if (Date.now() - startedAt > START_GRACE_MS) return { kind: 'timeout' };
      continue;
    }
    ctx.phase('restarting');
    if (await versionConfirmed(ctx.nodeId, ctx.targetVersion)) return { kind: 'done' };
  }
  return { kind: 'timeout' };
}

function confirmText(t: Translate, row: NodeRow, version: string | null): string {
  const target = version ?? t('nodes.upgrade.latestPending');
  return row.isSelf
    ? t('nodes.upgrade.confirmSelf', { version: target })
    : t('nodes.upgrade.confirmRemote', { name: row.name, version: target });
}

export function upgradeErrorText(t: Translate, code: string): string {
  const key = ERROR_KEYS[code];
  return key ? t(key) : code;
}

/** 阶段 → 按钮上的进度文案；静止阶段没有文案。 */
export function upgradePhaseText(t: Translate, phase: NodeUpgradePhase): string | null {
  if (phase === 'downloading') return t('nodes.upgrade.stateDownloading');
  if (phase === 'executing') return t('nodes.upgrade.stateExecuting');
  if (phase === 'restarting' || phase === 'pending') return t('nodes.upgrade.stateRestarting');
  return null;
}

export function isUpgradeBusy(phase: NodeUpgradePhase): boolean {
  return phase !== 'idle' && phase !== 'done' && phase !== 'failed';
}

export function useNodeUpgrade(onChanged: () => void): NodeUpgradeController {
  const { t } = useTranslation();
  const [latest, setLatest] = useState<NodeUpgradeLatest | null>(null);
  const [entries, setEntries] = useState<Record<string, NodeUpgradeEntry>>({});
  const aliveRef = useRef(true);
  const runningRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchUpgradeLatest()
      .then((value) => {
        if (!cancelled && value) setLatest(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback((nodeId: string, entry: Partial<NodeUpgradeEntry>) => {
    if (!aliveRef.current) return;
    setEntries((prev) => ({
      ...prev,
      [nodeId]: { ...(prev[nodeId] ?? IDLE_UPGRADE_ENTRY), ...entry },
    }));
  }, []);

  const run = useCallback(
    async (row: NodeRow, targetVersion: string | null) => {
      patch(row.id, { phase: 'pending', targetVersion, error: null });
      const started = await postUpgrade(row.id).catch(() => ({
        ok: false as const,
        code: 'NODE_UNREACHABLE',
      }));
      if (!started.ok) {
        // 已是最新是良性结论，不当失败报。
        if (started.code === 'UPGRADE_ALREADY_LATEST') {
          patch(row.id, { phase: 'idle', error: null });
          toast.info(t('nodes.upgrade.alreadyLatest', { name: row.name }));
          return;
        }
        const error = upgradeErrorText(t, started.code);
        patch(row.id, { phase: 'failed', error });
        toast.error(t('nodes.upgrade.failed', { error }));
        return;
      }
      const version = started.status.targetVersion ?? targetVersion;
      patch(row.id, { phase: started.status.state, targetVersion: version });
      toast.success(t('nodes.upgrade.started', { version: version ?? '' }));
      const result = await watchUpgrade({
        nodeId: row.id,
        targetVersion: version,
        sawActive: started.status.state !== 'idle',
        alive: () => aliveRef.current,
        phase: (phase) => patch(row.id, { phase }),
      });
      if (result.kind === 'done') {
        patch(row.id, { phase: 'done', error: null });
        toast.success(t('nodes.upgrade.done', { name: row.name, version: version ?? '' }));
        onChanged();
        return;
      }
      if (result.kind === 'failed') {
        patch(row.id, { phase: 'failed', error: result.error });
        toast.error(t('nodes.upgrade.failed', { error: result.error }));
        return;
      }
      patch(row.id, { phase: 'failed', error: t('nodes.upgrade.timeout') });
      toast.warning(t('nodes.upgrade.timeout'));
      onChanged();
    },
    [onChanged, patch, t]
  );

  const start = useCallback(
    (row: NodeRow) => {
      if (runningRef.current.has(row.id)) return;
      const version = latest?.latestVersion ?? null;
      if (!globalThis.confirm?.(confirmText(t, row, version))) return;
      runningRef.current.add(row.id);
      void run(row, version).finally(() => runningRef.current.delete(row.id));
    },
    [latest, run, t]
  );

  const entryOf = useCallback((nodeId: string) => entries[nodeId] ?? IDLE_UPGRADE_ENTRY, [entries]);

  return { latest, entryOf, start };
}
