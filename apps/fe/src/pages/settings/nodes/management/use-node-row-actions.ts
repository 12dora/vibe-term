// 节点行的两个异步动作：重命名与吊销。行组件只管渲染，动作的锁与错误处理都留在这里。
//
// 吊销本体（`revokeNodeRecord`）与「取签名者 / 弹提示」分开：卡头的批量「移除节点」与
// 远程卸载都要用同一段逻辑，且整批只让用户确认一次凭据。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { headFromResponse } from '@/auth/key-log-actions';
import type { RecordSigner } from '@/auth/key-log-actions';
import { buildRevokeNodeRecord, classifyKeyLogFailure } from '@/node/enrollment';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { NodeRow } from '@/node/mesh-nodes';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { actionErrorText } from './errors';
import type { NodeActionDeps, ResolvedMode } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 一次吊销的结论。`unconfirmed`：hub 没确认，服务端一条都没落库，节点**没有**被移除。 */
export type RevokeAttempt =
  | { kind: 'done' }
  | { kind: 'unconfirmed'; error: string }
  | { kind: 'stale' }
  | { kind: 'failed'; message: string };

export interface RevokeContext {
  api: AuthApi;
  mode: ResolvedMode;
  writerPublicUrl: string | null;
  t: Translate;
}

/**
 * 吊销一台节点：**只有一条路径**——`POST /api/auth/keylog?hub=sync`。
 * entry 先把签好的记录送 hub 等 ack，再本地 append。
 * 老实现「本地 append + 再调 hub revoke」是两条独立通道，先到的那条会让另一条报 `seq_gap`，
 * UI 误报 hub 失败；两条都失败时本地却已经把节点从列表里摘掉（见 F4-3 评审 Major）。
 *
 * `keyLogHead → 签名 → append` 整段进引擎那条 key log 写锁：head 是全局的，
 * 一条吊销与一条 admit 并行读到同一个头就会造出两条同 seq 的记录，hub 只收得下一条，
 * 另一条永久 `seq_gap`（见 R5 #1）。等用户操作的凭据对话框必须留在锁**外**，
 * 否则用户发一会儿呆就把所有 admit 卡住了。
 */
export async function revokeNodeRecord(
  signer: RecordSigner,
  row: Pick<NodeRow, 'id' | 'name'>,
  reason: string,
  ctx: RevokeContext
): Promise<RevokeAttempt> {
  try {
    const rootEpoch = requireRootEpoch(ctx.mode);
    const result = await withKeyLogLock(async () => {
      const head = headFromResponse(await ctx.api.keyLogHead());
      const record = await buildRevokeNodeRecord({
        head,
        rootEpoch,
        uid: ctx.mode.uid,
        nodeIdHex: row.id,
        reason,
        signer,
      });
      return ctx.api.appendKeyLog(
        { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
        { hubSync: true }
      );
    });
    if (!result.ok) {
      // B2-6：hub 未确认时服务端一条都没落库（409 / 504），撤销**没有生效**。
      const failure = classifyKeyLogFailure(result.code);
      if (failure === 'unconfirmed') return { kind: 'unconfirmed', error: result.code };
      if (failure === 'stale') return { kind: 'stale' };
      return {
        kind: 'failed',
        message: actionErrorText(
          ctx.t,
          { code: result.code },
          { writerPublicUrl: ctx.writerPublicUrl }
        ),
      };
    }
    if (result.hubAck !== true) return { kind: 'unconfirmed', error: result.hubError ?? '' };
    return { kind: 'done' };
  } catch (err) {
    return {
      kind: 'failed',
      message: actionErrorText(ctx.t, err, { writerPublicUrl: ctx.writerPublicUrl }),
    };
  }
}

/** 单台吊销的提示；返回是否成功，批量路径据此计数。 */
export function reportRevokeAttempt(t: Translate, attempt: RevokeAttempt): boolean {
  if (attempt.kind === 'done') {
    toast.success(t('nodes.revoke.done'));
    return true;
  }
  if (attempt.kind === 'unconfirmed') {
    toast.warning(t('nodes.revoke.hubFailed', { error: attempt.error }));
    return false;
  }
  toast.error(attempt.kind === 'stale' ? t('nodes.enrollment.staleRecord') : attempt.message);
  return false;
}

export interface BulkRevokeSummary {
  succeeded: number;
  failedNames: string[];
}

/**
 * 逐台吊销。**必须串行**：key log 是一条链，并行只会互相把对方顶成 `seq_gap`。
 * 一台失败不影响后面几台，失败的名字进汇总提示。
 */
export async function revokeNodesSequentially(
  signer: RecordSigner,
  rows: NodeRow[],
  reason: string,
  ctx: RevokeContext
): Promise<BulkRevokeSummary> {
  const summary: BulkRevokeSummary = { succeeded: 0, failedNames: [] };
  for (const row of rows) {
    const attempt = await revokeNodeRecord(signer, row, reason, ctx);
    if (attempt.kind === 'done') summary.succeeded += 1;
    else summary.failedNames.push(row.name);
  }
  return summary;
}

export function useNodeRowActions(
  row: NodeRow,
  { hubApi, mode, api, prompt, onChanged, writerPublicUrl }: NodeActionDeps
) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(row.name);
  const [busy, setBusy] = useState(false);

  const rename = useCallback(async () => {
    if (!hubApi) return;
    setBusy(true);
    try {
      await hubApi.rename(row.id, nameDraft);
      setRenaming(false);
      toast.success(t('nodes.rename.done'));
      onChanged();
    } catch (err) {
      toast.error(actionErrorText(t, err, { writerPublicUrl }));
    } finally {
      setBusy(false);
    }
  }, [hubApi, nameDraft, onChanged, row.id, t, writerPublicUrl]);

  /**
   * 凭据走 `withSigner`（**不**进 5 分钟复用窗口）：吊销是破坏性动作，每次都要用户当场确认；
   * 根钥路径签完立刻清零 seed。
   */
  const revoke = useCallback(async () => {
    const confirmed = globalThis.confirm?.(t('nodes.revoke.confirmText', { name: row.name }));
    if (!confirmed) return;
    const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
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
  }, [api, mode, onChanged, prompt, row, t, writerPublicUrl]);

  return { renaming, setRenaming, nameDraft, setNameDraft, busy, rename, revoke };
}

export interface BulkRevokeDeps {
  api: AuthApi;
  /** 未确认（缺 uid / kdf）时整个动作不可用。 */
  mode: ResolvedMode | null;
  prompt: CredentialPromptHandle;
  writerPublicUrl: string | null;
  onChanged: () => void;
}

/**
 * 卡头「更多 → 移除节点」：一次确认列出全部名字，整批只要一次凭据，随后串行吊销。
 * 与行内吊销共用 `revokeNodeRecord`，差别只在提示是逐条还是一条汇总。
 */
export function useBulkRevoke({ mode, api, prompt, onChanged, writerPublicUrl }: BulkRevokeDeps): {
  busy: boolean;
  revokeRows: (rows: NodeRow[]) => Promise<void>;
} {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const revokeRows = useCallback(
    async (rows: NodeRow[]) => {
      const targets = rows.filter((row) => !row.isSelf);
      if (targets.length === 0 || !mode) return;
      const names = targets.map((row) => row.name).join('、');
      const confirmed = globalThis.confirm?.(
        t('nodes.revoke.bulkConfirm', { count: targets.length, names })
      );
      if (!confirmed) return;
      const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
      setBusy(true);
      try {
        const summary = await prompt.withSigner(
          (signer) =>
            revokeNodesSequentially(signer, targets, reason, { api, mode, writerPublicUrl, t }),
          { purpose: 'revoke' }
        );
        if (!summary) return;
        if (summary.failedNames.length === 0) {
          toast.success(t('nodes.revoke.bulkDone', { count: summary.succeeded }));
        } else {
          toast.error(
            t('nodes.revoke.bulkFailed', {
              count: summary.succeeded,
              failed: summary.failedNames.length,
              names: summary.failedNames.join('、'),
            })
          );
        }
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [api, mode, onChanged, prompt, t, writerPublicUrl]
  );

  return { busy, revokeRows };
}
