/** DNS 解析单独封顶，避免把 Binding 预算吃光。 */
export const STUN_DNS_BUDGET_MS = 1_500;
/** Binding 无论 DNS 花了多久至少留这么久。 */
export const STUN_BINDING_MIN_MS = 1_000;
/** DNS + Binding 的墙钟上限。 */
export const STUN_PROBE_TOTAL_MAX_MS = 3_500;
/** 遗留单预算路径（测试注入的短 timeout）里 Binding 的下限。 */
export const STUN_PROBE_MIN_BIND_MS = 100;

export type StunProbePhaseBudget = {
  dnsBudgetMs: number;
  bindBudgetMs: number;
  skipBind: boolean;
};

/**
 * 把一次 STUN 探测拆成 DNS / Binding 两段。
 * 未覆盖 `timeoutMs` 时：DNS ≤ 1.5 s，Binding ≥ 1 s，合计 ≤ 3.5 s。
 * 测试传入更短的 `timeoutMs` 时保持「剩余不够就跳过 Binding」的旧语义。
 */
export function stunProbePhaseBudget(elapsedMs: number, timeoutMs: number): StunProbePhaseBudget {
  const elapsed = Math.max(0, elapsedMs);
  const remaining = timeoutMs - elapsed;
  if (timeoutMs <= 2_000) {
    const skipBind = remaining <= STUN_PROBE_MIN_BIND_MS && elapsed >= STUN_PROBE_MIN_BIND_MS;
    return {
      dnsBudgetMs: Math.max(1, timeoutMs - STUN_PROBE_MIN_BIND_MS),
      bindBudgetMs: Math.max(0, remaining),
      skipBind: skipBind || remaining <= 0,
    };
  }
  const dnsBudgetMs = Math.min(STUN_DNS_BUDGET_MS, Math.max(1, timeoutMs - STUN_BINDING_MIN_MS));
  const bindBudgetMs = Math.max(STUN_BINDING_MIN_MS, remaining);
  return {
    dnsBudgetMs,
    bindBudgetMs,
    skipBind: elapsed >= dnsBudgetMs && remaining < STUN_BINDING_MIN_MS,
  };
}

export function stunDnsBudgetMs(timeoutMs: number): number {
  return stunProbePhaseBudget(0, timeoutMs).dnsBudgetMs;
}

export function stunProbeTimeoutMs(override?: number): number {
  return override ?? STUN_PROBE_TOTAL_MAX_MS;
}
