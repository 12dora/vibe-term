// 待批准行的「批准加入」以及批准结论的提示。

import type { AdmitPendingResult } from '@/node/admit-pending-node';
import { admitPendingNode } from '@/node/admit-pending-node';
import { NODE_ID_REUSED } from '@/node/admit-record';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { NodeRow } from '@/node/mesh-nodes';
import { fetchRelayMode } from '@/node/mesh-relay';
import { distributeMetaKey } from '@/node/relay-meta-key-admit';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { actionErrorText } from './errors';
import type { NodeActionDeps, ResolvedMode } from './types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** 「批准加入」需要的那几项依赖（与吊销同源，只是不需要 hub 通道）。 */
export type AdmitNodeDeps = Pick<
  NodeActionDeps,
  'api' | 'mode' | 'prompt' | 'writerPublicUrl' | 'onChanged'
>;

function reportAdmitErrorCode(t: Translate, code: string, writerPublicUrl: string | null): boolean {
  // `node_id_reused` = 这台机器早就被接纳过了（多半是上一次点确认已经落账，本页没看到
  // 结果）。按已加入收尾：刷新列表把待批准行清掉，后续的成员密钥补发照跑。
  if (code === NODE_ID_REUSED) {
    toast.success(t('nodes.enrollment.admitted'));
    return true;
  }
  toast.error(
    t('nodes.admit.failed', {
      error: actionErrorText(t, { code }, { writerPublicUrl }),
    })
  );
  return false;
}

/**
 * 批准的结论 → 一条提示；返回是否需要刷新列表。
 *
 * 「Hub 未确认」是**警告**不是失败：服务端一条都没落库，原样重发即可（见 `submitAdmitRecord`），
 * 提示里不能说成失败，否则用户会以为要重来一遍加入流程。
 */
export function reportAdmitResult(
  t: Translate,
  result: AdmitPendingResult,
  writerPublicUrl: string | null
): boolean {
  switch (result.kind) {
    case 'admitted':
      toast.success(t('nodes.enrollment.admitted'));
      return true;
    case 'cancelled':
      return false;
    case 'no-material':
      toast.error(t('nodes.admit.unavailable'));
      return false;
    case 'unconfirmed':
      toast.warning(t('nodes.enrollment.hubNotConfirmed'));
      return false;
    case 'stale':
      toast.error(t('nodes.enrollment.staleRecord'));
      return false;
    case 'error':
      return reportAdmitErrorCode(t, result.code, writerPublicUrl);
    default:
      toast.error(t('nodes.admit.failed', { error: result.message }));
      return false;
  }
}

/**
 * 「批准加入」之后的中继收尾：把当前世代的 `K_meta` 封给这台新节点。
 *
 * 签名者取自 admit 刚用过的那把（5 分钟复用窗口），窗口里没有就只落欠账——告警条会带着
 * 「补发成员密钥」一直挂着，绝不会静默消失。非中继模式什么都不做。
 */
async function followUpRelayMetaKey(input: {
  api: AuthApi;
  mode: ResolvedMode;
  nodeIdHex: string;
  t: Translate;
}): Promise<void> {
  if (!(await fetchRelayMode())) return;
  const result = await distributeMetaKey(
    { api: input.api, relayApi: defaultRelayTenantApi, mode: input.mode, lock: withKeyLogLock },
    input.nodeIdHex
  );
  if (result.ok) return;
  toast.warning(
    input.t('relay.tenant.metaKey.admitFailed', {
      error: actionErrorText(input.t, { code: result.code }, { writerPublicUrl: null }),
    })
  );
}

/**
 * 待批准行的「批准加入」。凭据进 5 分钟复用窗口（`purpose: 'admit'`）：与自动 admit 共用，
 * 连批几台只需确认一次。
 *
 * 凭据对话框与 key log 写锁都要等，期间 Hub 轮询可能把这一行改掉或整张表清空；因此把
 * 「最新的行 + 挂载状态」放进 ref，交给 `admitPendingNode` 在每次 await 之后复核
 * （与 enrollment 引擎复核权威 pending store 是同一条约束）。
 */
export function useAdmitNode(
  row: NodeRow,
  { api, mode, prompt, writerPublicUrl, onChanged }: AdmitNodeDeps
): { busy: boolean; admit: () => Promise<void> } {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const rowRef = useRef(row);
  rowRef.current = row;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stillValid = useCallback((enrollmentId: string) => {
    if (!mountedRef.current) return false;
    const latest = rowRef.current;
    return latest.pending === true && latest.admitMaterial?.enrollmentId === enrollmentId;
  }, []);

  const admit = useCallback(async () => {
    setBusy(true);
    try {
      const nodeIdHex = rowRef.current.id;
      const result = await admitPendingNode(rowRef.current, { api, mode, prompt, stillValid });
      if (!reportAdmitResult(t, result, writerPublicUrl)) return;
      // 这条路不经 enrollment 引擎，中继模式下的成员密钥补发必须在这里显式跟上：
      // 少了它，新节点解不开元数据块，名字与版本永远上报不了（见 relay-meta-key-admit.ts）。
      await followUpRelayMetaKey({ api, mode, nodeIdHex, t });
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [api, mode, onChanged, prompt, stillValid, t, writerPublicUrl]);

  return { busy, admit };
}
