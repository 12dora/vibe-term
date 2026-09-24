// 每 node 一份的「最近一次登录失败」记账，外加网络类失败的自动退避重试。
//
// 为什么要做成宿主级的 store 而不是组件 state：同一台 node 的登录态在侧边栏、设备页分组、
// 节点管理表三处各画一遍，只有节点管理表压根不发登录请求。把失败记在这里，三处才能对同一件事
// 给出同一句话——尤其是「连接不上」与「需要登录」的区分。
//
// 退避是这轮的硬要求：链路抖动时静默登录必然失败，停在错误态等用户点，用户点了又是一次失败；
// 而不设退避地重试等于前端自己再造一次拨号风暴。阶梯取 3–6 秒抖动起步、逐次翻倍、封顶 5 分钟、
// 最多 8 次，另加「页面重新可见 / 网络恢复」时立即重试一次（那是链路真的回来了的信号）。
// 转发器回的 `NODE_UNREACHABLE` 例外：那是入口到目标这一段不通，手机切回前台并不改变它，
// 恢复信号只换来一次立即重试、阶梯保留，否则每次切回前台都是每台 node 一轮新的 8 连发。
// 凭证类失败**不重试**：同一份会话钥再发多少次都是同一个结论，只能等用户介入。
//
// 定时器到点只做一件事——把失败记录抹掉。真正的重发由挂载中的门闸（`useNodeLoginGate`）
// 在下一帧自己完成：没有人在看这台 node 时就什么都不发生，不会有后台常驻的登录轮询。

import { onPageRecovery } from '@/node/mesh-recovery';
import { useSyncExternalStore } from 'react';
import { type NodeLoginFailureKind, classifyNodeLoginFailure } from './login-failure-kind';

const FORWARD_UNREACHABLE_CODE = 'NODE_UNREACHABLE';

/** 首次退避下限（再叠加抖动）。 */
export const LOGIN_RETRY_FIRST_MS = 3_000;
/** 首次退避上限。 */
export const LOGIN_RETRY_FIRST_MAX_MS = 6_000;
/** 退避封顶。 */
export const LOGIN_RETRY_MAX_MS = 300_000;
/** 自动重试次数上限；用完就停在错误态等用户或页面恢复信号。 */
export const LOGIN_RETRY_MAX_ATTEMPTS = 8;

export interface NodeLoginFailure {
  code: string;
  kind: NodeLoginFailureKind;
  /** 这台 node 已经自动重试过几次；凭证类恒为 0。 */
  attempts: number;
  /** 还排着一次自动重试（界面据此说「稍后自动重试」而不是「请重试」）。 */
  retrying: boolean;
}

export interface LoginRetryTimers {
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  /** `[0, 1)`；缺省 `Math.random`。 */
  random: () => number;
}

const realTimers: LoginRetryTimers = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: Math.random,
};

let timers: LoginRetryTimers = realTimers;
const failures = new Map<string, NodeLoginFailure>();
/** 连续失败次数：抹掉失败记录去重试时必须留着它，否则退避永远停在第一级。 */
const attempts = new Map<string, number>();
const retryTimers = new Map<string, unknown>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function cancelRetry(nodeId: string): void {
  const handle = retryTimers.get(nodeId);
  if (handle === undefined) return;
  retryTimers.delete(nodeId);
  timers.cancel(handle);
}

/** 第 n 次（n 从 1 起）失败后要等多久。 */
export function loginRetryDelayMs(attempt: number, random = Math.random): number {
  const span = LOGIN_RETRY_FIRST_MAX_MS - LOGIN_RETRY_FIRST_MS;
  const first = LOGIN_RETRY_FIRST_MS + Math.floor(random() * (span + 1));
  const delay = first * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, LOGIN_RETRY_MAX_MS);
}

/**
 * 记一次静默登录失败。网络类顺带排下一次自动重试；凭证类与其它结论只记录，不重试。
 * 返回写进 store 的记录，便于调用方直接断言。
 */
export function noteNodeLoginFailure(nodeId: string, code: string): NodeLoginFailure {
  cancelRetry(nodeId);
  const kind = classifyNodeLoginFailure(code);
  if (kind !== 'unreachable') {
    attempts.delete(nodeId);
    const record: NodeLoginFailure = { code, kind, attempts: 0, retrying: false };
    failures.set(nodeId, record);
    notify();
    return record;
  }
  const attempt = (attempts.get(nodeId) ?? 0) + 1;
  attempts.set(nodeId, attempt);
  const retrying = attempt <= LOGIN_RETRY_MAX_ATTEMPTS;
  const record: NodeLoginFailure = { code, kind, attempts: attempt, retrying };
  failures.set(nodeId, record);
  if (retrying) {
    const handle = timers.schedule(
      () => {
        retryTimers.delete(nodeId);
        // 只抹记录：真正的重发由还挂着的门闸在下一帧完成。
        if (failures.delete(nodeId)) notify();
      },
      loginRetryDelayMs(attempt, timers.random)
    );
    retryTimers.set(nodeId, handle);
  }
  notify();
  return record;
}

/** 登录成功：失败记录与退避阶梯一起清掉。 */
export function noteNodeLoginSuccess(nodeId: string): void {
  cancelRetry(nodeId);
  attempts.delete(nodeId);
  if (failures.delete(nodeId)) notify();
}

/** 用户主动重试（按按钮）：阶梯归零，门闸下一帧重新登一次。 */
export function retryNodeLoginNow(nodeId: string): void {
  noteNodeLoginSuccess(nodeId);
}

export function getNodeLoginFailure(nodeId: string): NodeLoginFailure | null {
  return failures.get(nodeId) ?? null;
}

export function subscribeNodeLoginFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNodeLoginFailure(nodeId: string): NodeLoginFailure | null {
  return useSyncExternalStore(
    subscribeNodeLoginFailures,
    () => getNodeLoginFailure(nodeId),
    () => null
  );
}

/**
 * 页面重新可见 / 网络恢复：链路可能刚回来，排着的退避一律作废、立即重试一次。
 * 阶梯只对 `NODE_UNREACHABLE` 以外的网络类失败归零。
 */
export function clearAllNodeLoginRetries(): void {
  let changed = false;
  for (const nodeId of [...retryTimers.keys()]) cancelRetry(nodeId);
  for (const [nodeId, record] of [...failures]) {
    if (record.kind !== 'unreachable') continue;
    failures.delete(nodeId);
    if (record.code !== FORWARD_UNREACHABLE_CODE) attempts.delete(nodeId);
    changed = true;
  }
  if (changed) notify();
}

/** 仅测试使用：换掉定时器实现（传 null 恢复真实定时器）并清空全部记账。 */
export function setNodeLoginRetryTimersForTest(next: LoginRetryTimers | null): void {
  for (const nodeId of [...retryTimers.keys()]) cancelRetry(nodeId);
  failures.clear();
  attempts.clear();
  timers = next ?? realTimers;
}

onPageRecovery(clearAllNodeLoginRetries);
