// 同一条通知事件可能经两条通道抵达同一个浏览器页面：
//   直投——事件产生机的运行时经自己的 WS 下发（tmux `notification` 事件 / `WATCH_EVENT`）；
//   转发——该机把事件转给汇聚节点，汇聚节点再经入口连接的 `NOTIFY_EVENT` 广播回来。
// 两条路谁先到不确定（也可能只到一条：浏览器没订阅那台设备、懒登录门闸还没放行），所以
// 不能靠「当前路由是谁」去猜哪一条会到，只能按事件身份去重：先到的那条弹，另一条丢掉。
//
// 身份键不含时间戳——直投那一路根本没有网关的 `timestamp`（`WATCH_EVENT` / tmux 事件都只带
// id 字段），两条路唯一能对齐的只有 id。时间维度由「认领窗口」承担：同一身份在
// `COALESCE_MS` 内的第二次认领判为重复；超过窗口的是真·再次发生，照常弹。
// 认领记录 `TTL_MS` 后清掉，registry 不会随会话增长。

/** 事件身份。缺席字段一律折成空串参与拼接，两条路只要都拿得到同一组 id 就能对齐。 */
export interface ToastIdentity {
  /** 统一用 `WebhookEvent` 的事件类型命名（tmux `notification` → `terminal_notification`）。 */
  eventType: string;
  /** 事件产生的 node；入口自身为 `self`。 */
  nodeId?: string | null;
  deviceId?: string | null;
  paneId?: string | null;
  ruleId?: string | null;
}

export interface ClaimToastOptions {
  now?: number;
  /** 同一身份在这个窗口内的重复认领判为同一条事件。 */
  coalesceMs?: number;
  /** 认领记录的存活时长。 */
  ttlMs?: number;
}

export const TOAST_DEDUPE_COALESCE_MS = 2_000;
export const TOAST_DEDUPE_TTL_MS = 10_000;

const claims = new Map<string, number>();

export function toastDedupeKey(identity: ToastIdentity): string {
  return [
    identity.eventType,
    identity.nodeId ?? '',
    identity.deviceId ?? '',
    identity.paneId ?? '',
    identity.ruleId ?? '',
  ].join('|');
}

function prune(now: number, ttlMs: number): void {
  for (const [key, at] of claims) {
    if (now - at > ttlMs) claims.delete(key);
  }
}

/**
 * 认领一条 toast：第一个认领方返回 `true`（该弹），窗口内的后来者返回 `false`（丢弃）。
 *
 * 重复认领**不**刷新时间戳：否则一串重复能把窗口无限往后顶，真正的下一次事件反而被吃掉。
 */
export function claimToast(key: string, options: ClaimToastOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? TOAST_DEDUPE_TTL_MS;
  const coalesceMs = options.coalesceMs ?? TOAST_DEDUPE_COALESCE_MS;
  prune(now, ttlMs);
  const claimedAt = claims.get(key);
  if (claimedAt !== undefined && now - claimedAt <= coalesceMs) return false;
  claims.set(key, now);
  return true;
}

/** 一步到位：拼键 + 认领。 */
export function claimToastFor(identity: ToastIdentity, options?: ClaimToastOptions): boolean {
  return claimToast(toastDedupeKey(identity), options);
}

/** 仅测试使用：清空认领记录。 */
export function resetToastDedupeForTest(): void {
  claims.clear();
}
