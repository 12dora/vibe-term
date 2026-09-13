// 节点行的两个异步动作：重命名与吊销。行组件只管渲染，动作的锁与错误处理都留在这里。
//
// 吊销本体（`revokeNodeRecord`）与「取签名者 / 弹提示」分开：卡头的批量「移除节点」与
// 远程卸载都要用同一段逻辑，且整批只让用户确认一次凭据。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { NodeRow } from '@/node/mesh-nodes';
import { fetchRelayMode } from '@/node/mesh-relay';
import { renameNodeViaKeyLog } from '@/node/rename-node';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { actionErrorText } from './errors';
import {
  reportRevokeAttempt,
  revokeNodeRecord,
  revokeNodesSequentially,
} from './revoke-node-record';
import type { NodeActionDeps, ResolvedMode, RevokeController, RevokePlan } from './types';

export type {
  BulkRevokeSummary,
  RevokeAttempt,
  RevokeContext,
} from './revoke-node-record';
export {
  reportRevokeAttempt,
  revokeLanded,
  revokeNodeRecord,
  revokeNodesSequentially,
} from './revoke-node-record';
export type { AdmitNodeDeps } from './use-admit-node';
export { reportAdmitResult, useAdmitNode } from './use-admit-node';

/**
 * 吊销确认框的开合。确认即关框：紧随其后的凭据对话框（吊销每次都要用户当场确认）
 * 不能与它叠在一起，原因随确认一并交给执行体。
 */
function useRevokePlan(run: (plan: RevokePlan, reason: string) => void): {
  request: (plan: RevokePlan) => void;
  controller: RevokeController;
} {
  const [plan, setPlan] = useState<RevokePlan | null>(null);
  const dismiss = useCallback(() => setPlan(null), []);
  const confirm = useCallback(
    (reason: string) => {
      if (!plan) return;
      setPlan(null);
      run(plan, reason);
    },
    [plan, run]
  );
  return { request: setPlan, controller: { plan, confirm, dismiss } };
}

export function useNodeRowActions(
  row: NodeRow,
  { hubApi, mode, api, prompt, onChanged, writerPublicUrl }: NodeActionDeps
) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  /**
   * 重命名：**抛错不吞**。调用方是节点详情框，它要把这条错误与「域名访问」那条并排列出来，
   * 在这里弹 toast 只会变成两套互相打架的反馈。
   *
   * 中继模式下没有 hub 控制面，改名走 `rename-node` 记录（需要一次凭据）。
   * 「本机是不是中继模式」当场问网关，与吊销同一条判据：那份轮询快照最长陈旧 30 秒。
   */
  const rename = useCallback(
    async (name: string) => {
      if (await fetchRelayMode()) {
        const result = await prompt.withSigner(
          (signer) => renameNodeViaKeyLog({ api, mode }, { nodeIdHex: row.id, name }, signer),
          { purpose: 'revoke' }
        );
        if (!result) throw new Error(t('nodes.rename.cancelled'));
        if (!result.ok) {
          throw new Error(actionErrorText(t, { code: result.code }, { writerPublicUrl }));
        }
        return;
      }
      if (!hubApi) throw new Error(t('nodes.hubOffline'));
      await hubApi.rename(row.id, name);
    },
    [api, hubApi, mode, prompt, row.id, t, writerPublicUrl]
  );

  /**
   * 凭据走 `withSigner`（**不**进 5 分钟复用窗口）：吊销是破坏性动作，每次都要用户当场确认；
   * 根钥路径签完立刻清零 seed。
   */
  const runRevoke = useCallback(
    async (reason: string) => {
      setBusy(true);
      try {
        const attempt = await prompt.withSigner(
          (signer) => revokeNodeRecord(signer, row, reason, { api, mode, writerPublicUrl, t }),
          { purpose: 'revoke' }
        );
        if (!attempt) return;
        if (reportRevokeAttempt(t, attempt)) onChanged();
      } finally {
        setBusy(false);
      }
    },
    [api, mode, onChanged, prompt, row, t, writerPublicUrl]
  );

  const gate = useRevokePlan(
    useCallback((_plan: RevokePlan, reason: string) => void runRevoke(reason), [runRevoke])
  );
  const request = gate.request;
  const revoke = useCallback(() => request({ kind: 'single', targets: [row] }), [request, row]);

  return { busy, rename, revoke, revokeDialog: gate.controller };
}

export interface BulkRevokeDeps {
  api: AuthApi;
  /** 未确认（缺 uid / kdf）时整个动作不可用。 */
  mode: ResolvedMode | null;
  prompt: CredentialPromptHandle;
  writerPublicUrl: string | null;
  onChanged: () => void;
}

function reportBulkRevokeSummary(
  t: (key: string, options?: Record<string, unknown>) => string,
  summary: { succeeded: number; failedNames: string[]; metaPending: number }
): void {
  if (summary.metaPending > 0) {
    toast.warning(t('relay.tenant.metaKey.revokePendingBulk', { count: summary.metaPending }));
  }
  if (summary.failedNames.length === 0) {
    toast.success(t('nodes.revoke.bulkDone', { count: summary.succeeded }));
    return;
  }
  toast.error(
    t('nodes.revoke.bulkFailed', {
      count: summary.succeeded,
      failed: summary.failedNames.length,
      names: summary.failedNames.join('、'),
    })
  );
}

/**
 * 卡头「更多 → 移除节点」：一次确认列出全部名字，整批只要一次凭据，随后串行吊销。
 * 与行内吊销共用 `revokeNodeRecord`，差别只在提示是逐条还是一条汇总。
 */
export function useBulkRevoke({ mode, api, prompt, onChanged, writerPublicUrl }: BulkRevokeDeps): {
  busy: boolean;
  revokeRows: (rows: NodeRow[]) => void;
  revokeDialog: RevokeController;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const runRevoke = useCallback(
    async (targets: NodeRow[], reason: string) => {
      if (!mode) return;
      setBusy(true);
      try {
        const summary = await prompt.withSigner(
          (signer) =>
            revokeNodesSequentially(signer, targets, reason, { api, mode, writerPublicUrl, t }),
          { purpose: 'revoke' }
        );
        if (!summary) return;
        reportBulkRevokeSummary(t, summary);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [api, mode, onChanged, prompt, t, writerPublicUrl]
  );

  const gate = useRevokePlan(
    useCallback(
      (plan: RevokePlan, reason: string) => void runRevoke(plan.targets, reason),
      [runRevoke]
    )
  );
  const request = gate.request;
  const revokeRows = useCallback(
    (rows: NodeRow[]) => {
      const targets = rows.filter((row) => !row.isSelf);
      if (targets.length === 0 || !mode) return;
      request({ kind: 'bulk', targets });
    },
    [mode, request]
  );

  return { busy, revokeRows, revokeDialog: gate.controller };
}
