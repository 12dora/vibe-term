// 升级与入口之间的 REST 往返：POST 发起 / GET 轮询 / DELETE 中断 / 版本回读 / 补登录，
// 外加「非 2xx 该重试还是收尾」的分类。状态机（`./use-node-upgrade`）只认 `UpgradeIo` 这层接缝，
// 单测注入假实现就能不碰网络、不碰计时器地跑完整条流程。
//
// 三条请求的共同约定：`signal` 已经 abort 时一律回 `cancelled`，绝不把用户按下的「停止」
// 说成失败；读不出回包也不改判结论，宁可按「结果未知」继续轮询。

import { type LoginNodeResult, ensureNodeLogin } from '@/auth/session-key-store';
import { getMeshNodesState, refreshMeshNodes } from '@/node/mesh-nodes';
import { defaultApiClient } from '@vibeterm/api-client';
import { UPGRADE_CANCELLED, type UpgradeStatus, sleepOrAbort } from '@vibeterm/shared';
import type { NodeUpgradeLatest } from './types';

/** 后端取消升级后留在 idle 状态上的标记；FE 必须按「已取消」而不是失败处理。 */
export const UPGRADE_CANCELLED_ERROR: string = UPGRADE_CANCELLED;

/** 轮询期间必须立刻收尾的业务错误：节点被吊销、会话失效、目标压根不支持升级。 */
const DEFINITIVE_POLL_CODES = new Set([
  'NOT_FOUND',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NODE_LOGIN_REQUIRED',
  'UPGRADE_NOT_ALLOWED',
  'UPGRADE_UNSUPPORTED',
]);

/**
 * 轮询拿到非 2xx 时该重试还是收尾。
 * 5xx（502/503/504 等）是入口转发不到目标，也就是「重启中」的常态，继续等；
 * 4xx 与明确的业务码是确定性结论，再等六分钟只会给用户一个牛头不对马嘴的超时提示。
 */
export function classifyPollFailure(status: number, code: string): 'retry' | 'definitive' {
  if (DEFINITIVE_POLL_CODES.has(code)) return 'definitive';
  return status >= 500 ? 'retry' : 'definitive';
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

/** `unconfirmed`：POST 回包丢了，目标可能已经在升级——只能靠轮询与版本变化确认。 */
export type UpgradeStartOutcome =
  | { kind: 'started'; status: UpgradeStatus }
  | { kind: 'unconfirmed' }
  | { kind: 'alreadyLatest' }
  | { kind: 'failed'; code: string }
  | { kind: 'cancelled' };

/** `unreachable`：目标暂时打不通（网络异常 / 5xx），按「重启中」继续等。 */
export type UpgradePollOutcome =
  | { kind: 'status'; status: UpgradeStatus }
  | { kind: 'unreachable' }
  | { kind: 'failed'; code: string }
  | { kind: 'cancelled' };

/** `DELETE /api/mesh/nodes/:id/upgrade` 的两种结论；`httpStatus` 只用于诊断，判定一律看 `code`。 */
export type UpgradeCancelOutcome =
  | { kind: 'cancelled'; status: UpgradeStatus }
  | { kind: 'failed'; code: string; httpStatus: number };

/** 状态机与真实请求之间的接缝：单测注入假实现，不碰网络与计时器。 */
export interface UpgradeIo {
  start(nodeId: string, signal: AbortSignal): Promise<UpgradeStartOutcome>;
  /**
   * 目标说「须先登录」时当场补一次登录；不给就用默认实现（允许弹通行密钥仪式）。
   * 成败记账由 `ensureNodeLogin` 自己完成，本层不再记第二笔。
   */
  login?(nodeId: string): Promise<LoginNodeResult>;
  /** 轮询与刷新后的状态回读共用同一个 GET。 */
  poll(nodeId: string, signal: AbortSignal): Promise<UpgradePollOutcome>;
  cancel(nodeId: string, signal: AbortSignal): Promise<UpgradeCancelOutcome>;
  /** 刷新节点列表后回读目标版本；节点已不在列表返回 `undefined`。 */
  nodeVersion(nodeId: string): Promise<string | null | undefined>;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
  now(): number;
}

async function requestUpgradeStart(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradeStartOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal,
    });
  } catch {
    // 链路在回包前断掉：目标可能已经开始升级，绝不能报失败并重新放开按钮。
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'unconfirmed' };
  }
  if (res.ok) {
    try {
      return { kind: 'started', status: (await res.json()) as UpgradeStatus };
    } catch {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'unconfirmed' };
    }
  }
  const code = await readCode(res);
  if (signal.aborted) return { kind: 'cancelled' };
  if (code === 'UPGRADE_ALREADY_LATEST') return { kind: 'alreadyLatest' };
  // 入口转发不到目标时不会重试 POST，但目标可能已经收到并开始执行。
  if (code === 'NODE_UNREACHABLE') return { kind: 'unconfirmed' };
  return { kind: 'failed', code };
}

async function requestUpgradeStatus(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradePollOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, { signal });
  } catch {
    return signal.aborted ? { kind: 'cancelled' } : { kind: 'unreachable' };
  }
  if (res.ok) {
    try {
      return { kind: 'status', status: (await res.json()) as UpgradeStatus };
    } catch {
      return signal.aborted ? { kind: 'cancelled' } : { kind: 'unreachable' };
    }
  }
  const code = await readCode(res);
  if (signal.aborted) return { kind: 'cancelled' };
  if (classifyPollFailure(res.status, code) === 'retry') return { kind: 'unreachable' };
  return { kind: 'failed', code };
}

async function requestUpgradeCancel(
  nodeId: string,
  signal: AbortSignal
): Promise<UpgradeCancelOutcome> {
  let res: Response;
  try {
    res = await defaultApiClient.fetch(`/api/mesh/nodes/${nodeId}/upgrade`, {
      method: 'DELETE',
      signal,
    });
  } catch {
    return { kind: 'failed', code: 'NODE_UNREACHABLE', httpStatus: 0 };
  }
  if (res.ok) {
    try {
      return { kind: 'cancelled', status: (await res.json()) as UpgradeStatus };
    } catch {
      // 回包读不出来不影响结论：200 就是已取消。
      return {
        kind: 'cancelled',
        status: {
          state: 'idle',
          targetVersion: null,
          error: UPGRADE_CANCELLED_ERROR,
          startedAt: null,
        },
      };
    }
  }
  return { kind: 'failed', code: await readCode(res), httpStatus: res.status };
}

async function readNodeVersion(nodeId: string): Promise<string | null | undefined> {
  await refreshMeshNodes();
  const node = getMeshNodesState().nodes.find((item) => item.id === nodeId);
  return node ? (node.version ?? null) : undefined;
}

/** 升级是用户按下按钮才发生的，因此这条登录允许当场弹一次通行密钥仪式。 */
export function loginForUpgrade(nodeId: string): Promise<LoginNodeResult> {
  return ensureNodeLogin(nodeId, { allowPasskeyPrompt: true });
}

export const defaultUpgradeIo: UpgradeIo = {
  start: requestUpgradeStart,
  login: loginForUpgrade,
  poll: requestUpgradeStatus,
  cancel: requestUpgradeCancel,
  nodeVersion: readNodeVersion,
  wait: sleepOrAbort,
  now: () => Date.now(),
};
