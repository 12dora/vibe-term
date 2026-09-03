// 远程卸载：把目标机器上的 tmex 服务、程序与数据一并删掉，随后把它从 mesh 里移除。
//
// 两步且顺序不能反：先 `POST /api/mesh/nodes/:id/uninstall`（目标受理后自己脱离进程去删），
// 再对同一台跑一次签名吊销。反过来做的话，证书一撤入口就再也发不出卸载指令，机器上会留下
// 一个连不上任何人的常驻服务。
//
// 目标受理后随即离线，卸载结果**不可回读**：入口只在自己这边记一条 operation（`requested`
// → `uninstalling`），页面刷新后靠 `GET /api/mesh/nodes` 每行带回来的 `operation` 恢复行状态。
//
// 整批只让用户确认一次凭据：确认框已经把名字与后果列全，逐台再问一次密码只会让人放弃。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { NodeRow } from '@/node/mesh-nodes';
import { defaultApiClient } from '@tmex/api-client';
import type { AuthApi } from '@tmex/api-client/auth/index';
import type { MeshUninstallErrorCode } from '@tmex/shared';
import { compareSemver } from '@tmex/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type {
  NodeUninstallController,
  ResolvedMode,
  UninstallPlan,
  UninstallSkipReason,
} from './types';
import { revokeLanded, revokeNodeRecord } from './use-node-row-actions';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 首个带 `POST /api/system/uninstall` 的网关版本；更早的目标只能到机器上手动卸。 */
export const MIN_REMOTE_UNINSTALL_VERSION = '1.1.13';

const ERROR_KEYS: Record<MeshUninstallErrorCode, string> = {
  NODE_LOGIN_REQUIRED: 'nodes.uninstall.errors.loginRequired',
  NODE_UNREACHABLE: 'nodes.uninstall.errors.unreachable',
  UNINSTALL_NOT_ALLOWED: 'nodes.uninstall.errors.notAllowed',
  UNINSTALL_UNSUPPORTED: 'nodes.uninstall.errors.unsupported',
  UNINSTALL_SELF_BLOCKED: 'nodes.uninstall.errors.selfBlocked',
  UPGRADE_IN_PROGRESS: 'nodes.uninstall.errors.upgradeInProgress',
  NOT_FOUND: 'nodes.uninstall.errors.nodeGone',
};

/** 稳定错误码走文案表，其余原样显示——后端加了新码也不至于弹一句空话。 */
export function uninstallErrorText(t: Translate, code: string): string {
  const key = ERROR_KEYS[code as MeshUninstallErrorCode];
  return key ? t(key) : code;
}

/** 版本能解析且低于 `MIN_REMOTE_UNINSTALL_VERSION`。无法解析的版本不算，交给后端裁决。 */
export function isTooOldForRemoteUninstall(version: string | null): boolean {
  if (!version) return false;
  return compareSemver(version, MIN_REMOTE_UNINSTALL_VERSION) === -1;
}

/** 这台节点是否正在卸载（含刚受理还没等到服务端记录的那一档）。 */
export function isUninstalling(row: NodeRow, scheduledIds: ReadonlySet<string>): boolean {
  if (scheduledIds.has(row.id)) return true;
  return row.operation?.kind === 'uninstall' && row.operation.phase !== 'failed';
}

export function uninstallSkipReason(row: NodeRow): UninstallSkipReason | null {
  if (row.isSelf) return 'self';
  if (row.operation?.kind === 'uninstall' && row.operation.phase !== 'failed')
    return 'uninstalling';
  if (!row.online) return 'offline';
  if (!row.loggedIn) return 'loginRequired';
  if (isTooOldForRemoteUninstall(row.version)) return 'tooOld';
  return null;
}

/** 把选中的行分拣成「能卸」与「跳过 + 原因」，确认框据此把话说清楚。 */
export function planUninstall(rows: NodeRow[]): UninstallPlan {
  const plan: UninstallPlan = { targets: [], skipped: [] };
  for (const row of rows) {
    const reason = uninstallSkipReason(row);
    if (reason) plan.skipped.push({ row, reason });
    else plan.targets.push(row);
  }
  return plan;
}

export type UninstallStartOutcome = { kind: 'scheduled' } | { kind: 'failed'; code: string };

/** 状态机与真实请求之间的接缝：单测注入假 fetch，不碰网络。 */
export interface UninstallIo {
  /** `POST /api/mesh/nodes/:id/uninstall`。 */
  start(nodeId: string): Promise<UninstallStartOutcome>;
  /** `DELETE /api/mesh/nodes/:id/operation`：清掉失败留下的记录。 */
  clearOperation(nodeId: string): Promise<boolean>;
}

type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;

async function readCode(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { code?: unknown; error?: unknown };
    if (typeof payload.code === 'string') return payload.code;
    if (typeof payload.error === 'string') return payload.error;
  } catch {
    // 落到通用码
  }
  return 'UNINSTALL_FAILED';
}

export function createUninstallIo(
  fetchImpl: FetchLike = (path, init) => defaultApiClient.fetch(path, init)
): UninstallIo {
  return {
    async start(nodeId) {
      let res: Response;
      try {
        res = await fetchImpl(`/api/mesh/nodes/${nodeId}/uninstall`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        return { kind: 'failed', code: 'NODE_UNREACHABLE' };
      }
      // 卸载没有回读通道：POST 一律不重试，2xx 就是「目标已受理」。
      if (res.ok) return { kind: 'scheduled' };
      return { kind: 'failed', code: await readCode(res) };
    },
    async clearOperation(nodeId) {
      try {
        const res = await fetchImpl(`/api/mesh/nodes/${nodeId}/operation`, { method: 'DELETE' });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

export const defaultUninstallIo: UninstallIo = createUninstallIo();

export interface UninstallBatchSummary {
  /** 目标已受理卸载。 */
  scheduled: number;
  /** 受理后吊销也成功的台数。 */
  revoked: number;
  /** hub 中途不再收写入而没轮到的台数。 */
  aborted: number;
  failed: Array<{ name: string; message: string }>;
}

export interface UninstallBatchParams {
  targets: NodeRow[];
  io: UninstallIo;
  /** 受理后对同一台跑签名吊销；返回是否成功。 */
  revoke: (row: NodeRow) => Promise<boolean>;
  /** 受理成功时打的乐观标记：服务端记录要等下一次节点刷新才到。 */
  onScheduled: (nodeId: string) => void;
  /** 单台失败时立刻报一次：整批跑完才看到汇总，中途失败的那台会被埋没。 */
  onFailed?: (name: string, message: string) => void;
  /** 每台开跑前重新确认 hub 还收得下写入；返回 `false` 时整批就地停下。 */
  canWrite: () => boolean;
  t: Translate;
}

/**
 * 逐台串行：POST 失败就跳过这一台的吊销（证书还得留着，用户重试或到机器上手动卸），
 * 一台失败不影响后面几台。
 *
 * 每台开跑前重新确认 hub 还收得下写入：主 hub 中途掉线或 uplink 切到 standby 时再往下卸，
 * 只会把机器删干净却撤不掉证书。已经受理的那几台保留 `uninstalling` 记录，用户回头再吊销。
 */
export async function runUninstallBatch(p: UninstallBatchParams): Promise<UninstallBatchSummary> {
  const summary: UninstallBatchSummary = { scheduled: 0, revoked: 0, aborted: 0, failed: [] };
  const fail = (name: string, message: string) => {
    summary.failed.push({ name, message });
    p.onFailed?.(name, message);
  };
  for (const [index, row] of p.targets.entries()) {
    if (!p.canWrite()) {
      summary.aborted = p.targets.length - index;
      break;
    }
    const outcome = await p.io.start(row.id);
    if (outcome.kind === 'failed') {
      fail(row.name, uninstallErrorText(p.t, outcome.code));
      continue;
    }
    summary.scheduled += 1;
    p.onScheduled(row.id);
    if (await p.revoke(row)) summary.revoked += 1;
    else fail(row.name, p.t('nodes.uninstall.revokeFailed'));
  }
  return summary;
}

/** 汇总提示的文案与档次；提示本身由 `uninstallSummaryToast` 发出，方便单测只看文案。 */
export function uninstallSummaryText(
  t: Translate,
  summary: UninstallBatchSummary
): { level: 'success' | 'error'; text: string } {
  if (summary.aborted > 0) {
    return {
      level: 'error',
      text: t('nodes.uninstall.summaryAborted', {
        count: summary.scheduled,
        remaining: summary.aborted,
      }),
    };
  }
  if (summary.failed.length === 0) {
    return { level: 'success', text: t('nodes.uninstall.summary', { count: summary.scheduled }) };
  }
  return {
    level: 'error',
    text: t('nodes.uninstall.summaryFailed', {
      count: summary.scheduled,
      failed: summary.failed.length,
      names: summary.failed.map((row) => row.name).join('、'),
    }),
  };
}

export function uninstallSummaryToast(t: Translate, summary: UninstallBatchSummary): void {
  const { level, text } = uninstallSummaryText(t, summary);
  if (level === 'success') toast.success(text);
  else toast.error(text);
}

/** 卸载只用到签名与吊销那几样依赖；`mode` 未确认（缺 uid / kdf）时整个动作不可用。 */
export interface UninstallDeps {
  api: AuthApi;
  mode: ResolvedMode | null;
  prompt: CredentialPromptHandle;
  writerPublicUrl: string | null;
  /** hub 当前接受管理写入；卸载以一次签名吊销收尾，不可写时这个动作没有意义。 */
  writable: boolean;
}

export interface UseNodeUninstallOptions {
  io?: UninstallIo;
}

export function useNodeUninstall(
  deps: UninstallDeps,
  onChanged: () => void,
  options: UseNodeUninstallOptions = {}
): NodeUninstallController {
  const { t } = useTranslation();
  const io = options.io ?? defaultUninstallIo;
  const { api, mode, prompt, writable, writerPublicUrl } = deps;
  // 整批跑起来后 hub 随时可能掉线：每台开跑前读的必须是最新值，而不是点确认那一刻的快照。
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const [plan, setPlan] = useState<UninstallPlan | null>(null);
  const [running, setRunning] = useState(false);
  const [scheduledIds, setScheduledIds] = useState<ReadonlySet<string>>(() => new Set());
  const [clearingIds, setClearingIds] = useState<ReadonlySet<string>>(() => new Set());

  const request = useCallback((rows: NodeRow[]) => {
    setPlan(planUninstall(rows));
  }, []);

  const dismiss = useCallback(() => {
    setPlan(null);
  }, []);

  const confirm = useCallback(() => {
    const targets = plan?.targets ?? [];
    if (targets.length === 0 || !mode) {
      setPlan(null);
      return;
    }
    setRunning(true);
    void (async () => {
      try {
        // 整批一次凭据：签名者只活在这个回调里，返回即清零。
        const summary = await prompt.withSigner(
          (signer) =>
            runUninstallBatch({
              targets,
              io,
              t,
              onScheduled: (nodeId) => setScheduledIds((prev) => new Set(prev).add(nodeId)),
              onFailed: (name, message) => toast.error(`${name}：${message}`),
              canWrite: () => writableRef.current,
              revoke: async (row) => {
                const attempt = await revokeNodeRecord(signer, row, '', {
                  api,
                  mode,
                  writerPublicUrl,
                  t,
                });
                // 欠着 `meta-key` 换代也算移除成功（节点已经不在成员表里），
                // 那一条由节点页的重试回路继续送。
                return revokeLanded(attempt);
              },
            }),
          { purpose: 'revoke' }
        );
        if (summary) uninstallSummaryToast(t, summary);
      } finally {
        setRunning(false);
        setPlan(null);
        onChanged();
      }
    })();
  }, [api, io, mode, onChanged, plan, prompt, t, writerPublicUrl]);

  const clear = useCallback(
    (row: NodeRow) => {
      setClearingIds((previous) => new Set(previous).add(row.id));
      void (async () => {
        const ok = await io.clearOperation(row.id);
        setClearingIds((previous) => {
          const next = new Set(previous);
          next.delete(row.id);
          return next;
        });
        if (!ok) {
          toast.error(t('nodes.uninstall.clearFailed'));
          return;
        }
        setScheduledIds((previous) => {
          if (!previous.has(row.id)) return previous;
          const next = new Set(previous);
          next.delete(row.id);
          return next;
        });
        onChanged();
      })();
    },
    [io, onChanged, t]
  );

  return useMemo(
    () => ({ plan, running, scheduledIds, clearingIds, request, confirm, dismiss, clear }),
    [clear, clearingIds, confirm, dismiss, plan, request, running, scheduledIds]
  );
}
