// 退出编排：调用顺序、凭据取消、重复进入、退出被拒、重启超时、成功跳转。
// 依赖全部注入，不需要 DOM。

import { describe, expect, test } from 'bun:test';
import type { SetupIntentRecord } from './intent';
import {
  type LeaveRestartOutcome,
  type LeaveWorkflowDeps,
  awaitRestartAndNavigate,
  createInFlightGuard,
  runLeaveWorkflow,
} from './leave-controller';
import type { SelfRevokeOutcome } from './self-revoke';

interface Harness {
  deps: LeaveWorkflowDeps;
  calls: string[];
  intent: SetupIntentRecord | null;
  authTransition: boolean;
  phases: string[];
  leaveBodies: { expectedRole: string; targetRole?: string }[];
  baselines: (number | null)[];
}

function harness(
  overrides: {
    revoke?: SelfRevokeOutcome | null;
    startedAt?: number | null;
    leaveError?: unknown;
    restart?: LeaveRestartOutcome;
  } = {}
): Harness {
  const calls: string[] = [];
  const phases: string[] = [];
  const leaveBodies: { expectedRole: string; targetRole?: string }[] = [];
  const baselines: (number | null)[] = [];
  const h: Harness = {
    calls,
    phases,
    leaveBodies,
    baselines,
    intent: null,
    authTransition: false,
    deps: null as unknown as LeaveWorkflowDeps,
  };

  const deps: LeaveWorkflowDeps = {
    revoke:
      overrides.revoke === undefined || overrides.revoke === null
        ? null
        : async () => {
            calls.push('revoke');
            return overrides.revoke as SelfRevokeOutcome;
          },
    readStartedAt: async () => {
      calls.push('readStartedAt');
      return overrides.startedAt ?? 111;
    },
    leave: async (body) => {
      calls.push('leave');
      leaveBodies.push(body);
      if (overrides.leaveError) throw overrides.leaveError;
      return {};
    },
    waitForRestart: async (previous) => {
      calls.push('waitForRestart');
      baselines.push(previous);
      return overrides.restart ?? 'restarted';
    },
    navigate: () => calls.push('navigate'),
    writeIntent: (intent) => {
      calls.push('writeIntent');
      h.intent = intent;
    },
    clearIntent: () => {
      calls.push('clearIntent');
      h.intent = null;
    },
    beginAuthTransition: () => {
      calls.push('beginAuthTransition');
      h.authTransition = true;
    },
    endAuthTransition: () => {
      calls.push('endAuthTransition');
      h.authTransition = false;
    },
    setPhase: (phase) => phases.push(phase),
    onRevokeOutcome: (outcome) => calls.push(`revokeOutcome:${outcome.kind}`),
    onLeaveError: () => calls.push('leaveError'),
    onBaseline: () => calls.push('baseline'),
    release: () => calls.push('release'),
  };

  h.deps = deps;
  return h;
}

describe('runLeaveWorkflow 成功路径', () => {
  test('纯 node 换 hub：自吊销 → 采基线 → 写记号 → 置位鉴权切换 → leave → 等重启 → 跳转', async () => {
    const h = harness({ revoke: { kind: 'revoked' } });
    const outcome = await runLeaveWorkflow(h.deps, { from: 'node', intent: { path: 'join-hub' } });

    expect(outcome).toBe('restarted');
    expect(h.calls).toEqual([
      'revoke',
      'readStartedAt',
      'baseline',
      'writeIntent',
      'beginAuthTransition',
      'leave',
      'waitForRestart',
      'navigate',
    ]);
    expect(h.phases).toEqual(['confirming', 'leaving', 'restarting', 'restarted']);
    expect(h.leaveBodies).toEqual([{ expectedRole: 'node' }]);
    expect(h.intent).toEqual({ path: 'join-hub' });
    // 硬跳转会换掉整个 JS 环境，标记必须一直保持到那时。
    expect(h.authTransition).toBe(true);
  });

  test('基线在自吊销之后、leave 之前采样，并原样交给等待器', async () => {
    const h = harness({ revoke: { kind: 'revoked' }, startedAt: 42 });
    await runLeaveWorkflow(h.deps, { from: 'node', intent: null });
    expect(h.calls.indexOf('readStartedAt')).toBeGreaterThan(h.calls.indexOf('revoke'));
    expect(h.calls.indexOf('readStartedAt')).toBeLessThan(h.calls.indexOf('leave'));
    expect(h.baselines).toEqual([42]);
  });

  test('纯粹退出不写记号，反而把可能残留的旧记号清掉', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, { from: 'hub,node', intent: null });
    expect(h.calls).toContain('clearIntent');
    expect(h.calls).not.toContain('writeIntent');
    expect(h.leaveBodies).toEqual([{ expectedRole: 'hub,node' }]);
  });

  test('hub 兼节点不做自吊销（本机就是自己的 hub）', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, { from: 'hub,node', intent: { path: 'become-hub' } });
    expect(h.calls).not.toContain('revoke');
  });
});

describe('runLeaveWorkflow 自吊销结局', () => {
  test('用户取消凭据：只出提示，退出照常继续', async () => {
    const h = harness({ revoke: { kind: 'cancelled' } });
    const outcome = await runLeaveWorkflow(h.deps, { from: 'node', intent: null });
    expect(outcome).toBe('restarted');
    expect(h.calls).toContain('revokeOutcome:cancelled');
    expect(h.calls).toContain('leave');
  });

  test('吊销失败：同样只出提示，退出照常继续', async () => {
    const h = harness({ revoke: { kind: 'failed', reason: 'hub_unreachable' } });
    await runLeaveWorkflow(h.deps, { from: 'node', intent: null });
    expect(h.calls).toContain('revokeOutcome:failed');
    expect(h.calls).toContain('leave');
  });

  test('吊销成功不打扰用户', async () => {
    const h = harness({ revoke: { kind: 'revoked' } });
    await runLeaveWorkflow(h.deps, { from: 'node', intent: null });
    expect(h.calls.some((c) => c.startsWith('revokeOutcome'))).toBe(false);
  });
});

describe('runLeaveWorkflow 失败与终态', () => {
  test('leave 被明确拒绝：记号撤掉、鉴权标记撤掉、守卫放开、停在可重试的 error', async () => {
    const h = harness({ leaveError: new Error('role_mismatch') });
    const outcome = await runLeaveWorkflow(h.deps, {
      from: 'node',
      intent: { path: 'become-hub' },
    });

    expect(outcome).toBe('failed');
    expect(h.phases).toEqual(['leaving', 'error']);
    expect(h.intent).toBeNull();
    expect(h.authTransition).toBe(false);
    expect(h.calls).toContain('leaveError');
    expect(h.calls).toContain('release');
    // 已经拒了就不该再去等重启
    expect(h.calls).not.toContain('waitForRestart');
  });

  test('等重启超时是已提交后的终态：不放守卫、不撤鉴权标记、不跳转', async () => {
    const h = harness({ restart: 'timeout' });
    const outcome = await runLeaveWorkflow(h.deps, { from: 'node', intent: null });

    expect(outcome).toBe('timeout');
    expect(h.phases).toEqual(['leaving', 'restarting', 'timeout']);
    expect(h.calls).not.toContain('release');
    expect(h.calls).not.toContain('navigate');
    expect(h.authTransition).toBe(true);
  });

  test('被中断（组件卸载）不改阶段也不跳转', async () => {
    const h = harness({ restart: 'aborted' });
    const outcome = await runLeaveWorkflow(h.deps, { from: 'node', intent: null });
    expect(outcome).toBe('aborted');
    expect(h.phases).toEqual(['leaving', 'restarting']);
    expect(h.calls).not.toContain('navigate');
  });
});

describe('awaitRestartAndNavigate（超时后的「再查一次」）', () => {
  test('用同一个基线重跑等待，成功就跳转，绝不重发 leave', async () => {
    const h = harness({ restart: 'restarted' });
    const outcome = await awaitRestartAndNavigate(h.deps, 42);
    expect(outcome).toBe('restarted');
    expect(h.calls).toEqual(['waitForRestart', 'navigate']);
    expect(h.baselines).toEqual([42]);
  });

  test('还是没回来就退回超时终态', async () => {
    const h = harness({ restart: 'timeout' });
    expect(await awaitRestartAndNavigate(h.deps, null)).toBe('timeout');
    expect(h.phases).toEqual(['restarting', 'timeout']);
  });
});

describe('createInFlightGuard', () => {
  test('第二次进入被拒，直到显式放开', () => {
    const guard = createInFlightGuard();
    expect(guard.tryEnter()).toBe(true);
    expect(guard.tryEnter()).toBe(false);
    expect(guard.tryEnter()).toBe(false);
    guard.release();
    expect(guard.tryEnter()).toBe(true);
  });

  test('重复调用 run 时第二次拿不到守卫，整条流程一次都不会跑第二遍', async () => {
    const guard = createInFlightGuard();
    const h = harness({ restart: 'timeout' });
    const run = (from: 'node' | 'hub,node') =>
      guard.tryEnter()
        ? runLeaveWorkflow({ ...h.deps, release: guard.release }, { from, intent: null })
        : Promise.resolve('ignored' as const);

    const [first, second] = await Promise.all([run('node'), run('node')]);
    expect(first).toBe('timeout');
    expect(second).toBe('ignored');
    expect(h.leaveBodies).toHaveLength(1);
  });
});

describe('targetRole', () => {
  test('省略即退到 standalone：请求体里不出现 targetRole', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, { from: 'relay,node', intent: null });
    expect(h.leaveBodies).toEqual([{ expectedRole: 'relay,node' }]);
  });

  test('relay,node → relay：带上 targetRole，中继运营状态由后端保留', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, { from: 'relay,node', targetRole: 'relay', intent: null });
    expect(h.leaveBodies).toEqual([{ expectedRole: 'relay,node', targetRole: 'relay' }]);
  });

  test('显式 standalone 与省略等价', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, { from: 'node', targetRole: 'standalone', intent: null });
    expect(h.leaveBodies).toEqual([{ expectedRole: 'node' }]);
  });

  test('切到中继角色：记号带上目标角色，重启后表单直接预选', async () => {
    const h = harness();
    await runLeaveWorkflow(h.deps, {
      from: 'hub,node',
      intent: { path: 'become-relay', role: 'relay' },
    });
    expect(h.intent).toEqual({ path: 'become-relay', role: 'relay' });
  });
});
