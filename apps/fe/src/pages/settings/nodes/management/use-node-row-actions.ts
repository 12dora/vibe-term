// 节点行的两个异步动作：重命名与吊销。行组件只管渲染，动作的锁与错误处理都留在这里。

import { headFromResponse } from '@/auth/key-log-actions';
import { buildRevokeNodeRecord, classifyKeyLogFailure } from '@/node/enrollment';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { NodeRow } from '@/node/mesh-nodes';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { actionErrorText } from './errors';
import type { NodeActionDeps } from './types';

export function useNodeRowActions(
  row: NodeRow,
  { hubApi, mode, api, prompt, onChanged }: NodeActionDeps
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
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [hubApi, nameDraft, onChanged, row.id, t]);

  /**
   * 吊销：**只有一条路径**——`POST /api/auth/keylog?hub=sync`。
   * entry 先把签好的记录送 hub 等 ack，再本地 append。
   * 老实现「本地 append + 再调 hub revoke」是两条独立通道，先到的那条会让另一条报 `seq_gap`，
   * UI 误报 hub 失败；两条都失败时本地却已经把节点从列表里摘掉（见 F4-3 评审 Major）。
   *
   * 凭据走 `withSigner`（**不**进 5 分钟复用窗口）：吊销是破坏性动作，每次都要用户当场确认；
   * 根钥路径签完立刻清零 seed。
   *
   * `keyLogHead → 签名 → append` 整段进引擎那条 key log 写锁：head 是全局的，
   * 一条吊销与一条 admit 并行读到同一个头就会造出两条同 seq 的记录，hub 只收得下一条，
   * 另一条永久 `seq_gap`（见 R5 #1）。等用户操作的凭据对话框必须留在锁**外**，
   * 否则用户发一会儿呆就把所有 admit 卡住了。
   */
  const revoke = useCallback(async () => {
    const confirmed = globalThis.confirm?.(t('nodes.revoke.confirmText', { name: row.name }));
    if (!confirmed) return;
    const reason = globalThis.prompt?.(t('nodes.revoke.reasonPrompt')) ?? '';
    setBusy(true);
    try {
      const rootEpoch = requireRootEpoch(mode);
      const result = await prompt.withSigner(
        (signer) =>
          withKeyLogLock(async () => {
            const head = headFromResponse(await api.keyLogHead());
            const record = await buildRevokeNodeRecord({
              head,
              rootEpoch,
              uid: mode.uid,
              nodeIdHex: row.id,
              reason,
              signer,
            });
            return api.appendKeyLog(
              { bytes: encodeBase64url(record.bytes), sig: encodeBase64url(record.sig) },
              { hubSync: true }
            );
          }),
        { purpose: 'revoke' }
      );
      if (!result) return;
      if (!result.ok) {
        // B2-6：hub 未确认时服务端一条都没落库（409 / 504），撤销**没有生效**——
        // 文案必须这么说，否则用户会以为节点已经吊销掉了。
        const failure = classifyKeyLogFailure(result.code);
        if (failure === 'unconfirmed') {
          toast.warning(t('nodes.revoke.hubFailed', { error: result.code }));
          return;
        }
        toast.error(
          failure === 'stale'
            ? t('nodes.enrollment.staleRecord')
            : t(`auth.errors.${result.code}`, { defaultValue: result.code })
        );
        return;
      }
      if (result.hubAck !== true) {
        toast.warning(t('nodes.revoke.hubFailed', { error: result.hubError ?? '' }));
        return;
      }
      toast.success(t('nodes.revoke.done'));
      onChanged();
    } catch (err) {
      toast.error(actionErrorText(t, err));
    } finally {
      setBusy(false);
    }
  }, [api, mode, onChanged, prompt, row.id, row.name, t]);

  return { renaming, setRenaming, nameDraft, setNameDraft, busy, rename, revoke };
}
