import { describe, expect, test } from 'bun:test';
import {
  STUN_BINDING_MIN_MS,
  STUN_DNS_BUDGET_MS,
  STUN_PROBE_TOTAL_MAX_MS,
  stunDnsBudgetMs,
  stunProbePhaseBudget,
  stunProbeTimeoutMs,
} from './stun-probe-budget';

describe('stunProbePhaseBudget', () => {
  test('production total keeps DNS ≤ 1.5 s and Binding ≥ 1 s', () => {
    const start = stunProbePhaseBudget(0, STUN_PROBE_TOTAL_MAX_MS);
    expect(start.dnsBudgetMs).toBe(STUN_DNS_BUDGET_MS);
    expect(start.bindBudgetMs).toBeGreaterThanOrEqual(STUN_BINDING_MIN_MS);
    expect(start.skipBind).toBe(false);

    const afterDns = stunProbePhaseBudget(STUN_DNS_BUDGET_MS, STUN_PROBE_TOTAL_MAX_MS);
    expect(afterDns.bindBudgetMs).toBeGreaterThanOrEqual(STUN_BINDING_MIN_MS);
    expect(afterDns.bindBudgetMs + STUN_DNS_BUDGET_MS).toBeLessThanOrEqual(STUN_PROBE_TOTAL_MAX_MS);
    expect(afterDns.skipBind).toBe(false);
  });

  test('Binding still gets ≥ 1 s after a slow DNS within the 1.5 s cap', () => {
    const plan = stunProbePhaseBudget(1_400, STUN_PROBE_TOTAL_MAX_MS);
    expect(plan.bindBudgetMs).toBeGreaterThanOrEqual(STUN_BINDING_MIN_MS);
    expect(plan.skipBind).toBe(false);
  });

  test('legacy short timeout still skips Binding when DNS ate the budget', () => {
    const plan = stunProbePhaseBudget(1_950, 2_000);
    expect(plan.skipBind).toBe(true);
    expect(plan.bindBudgetMs).toBe(50);
  });

  test('stunProbeTimeoutMs defaults to the 3.5 s total cap', () => {
    expect(stunProbeTimeoutMs()).toBe(STUN_PROBE_TOTAL_MAX_MS);
    expect(stunProbeTimeoutMs(200)).toBe(200);
    expect(stunDnsBudgetMs(STUN_PROBE_TOTAL_MAX_MS)).toBe(STUN_DNS_BUDGET_MS);
  });
});
