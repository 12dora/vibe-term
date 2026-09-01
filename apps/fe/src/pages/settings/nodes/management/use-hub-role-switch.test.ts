// Hub 主备切换的编排：计划、按钮态、`admit-hub` 的强制路径、跨重启的轮询与断点续跑。
// 全部走注入的假 io / 假 fetch，不碰网络与真实计时器。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
import type { HubRoleRequest } from '@tmex/shared';
import { KEYLOG_TYPE_UNSUPPORTED_BY_NODES } from '@tmex/shared/auth';
import { createMemoryStorage } from '@tmex/stores/test-utils';
import {
  type AdmitHubOutcome,
  HUB_ROLE_RESTART_BUDGET_MS,
  HUB_ROLE_SWITCH_KEY,
  HUB_ROLE_SWITCH_TTL_MS,
  HUB_ROLE_WRITER_TIMEOUT_MS,
  type HubRoleIo,
  type HubRoleOutcome,
  type HubRoleResumePhase,
  type HubRoleSwitchPlan,
  type HubRoleSwitchRecord,
  admitHubWithForce,
  awaitHubRoleSwitch,
  clearHubRoleSwitch,
  hubRoleBlockReason,
  hubRoleButtonState,
  hubRoleSteps,
  hubRoleSwitchPersist,
  hubRoleWarnings,
  loadHubRoleSwitch,
  pickSuccessorHub,
  planHubRoleSwitch,
  promoteHub,
  randomOperationId,
  randomUuidV4,
  resumeHubRoleSwitch,
  runHubRoleSwitch,
  saveHubRoleSwitch,
  submitAdmitHubRecord,
} from './use-hub-role-switch';

const HUB_X = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const HUB_A = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';
const HUB_C = '0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c';

/** 文案在这里只需要可辨认：键名 + 参数拼一行，断言直接比字符串。 */
const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}(${JSON.stringify(options)})` : key;

function hub(overrides: Partial<MeshHubEndpoint> & { nodeId: string }): MeshHubEndpoint {
  return {
    publicUrl: `https://${overrides.nodeId}.example`,
    mode: 'standby',
    priority: 0,
    writerEpoch: 3,
    online: true,
    authorization: 'signed',
    ...overrides,
  };
}

function row(id: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    id,
    runtimeNodeId: id,
    name: id.slice(0, 4),
    publicKey: '',
    fingerprint: '',
    online: true,
    reach: null,
    transport: null,
    rttMs: null,
    version: '1.1.13',
    directCapable: false,
    loggedIn: true,
    inventory: null,
    isSelf: false,
    isHub: true,
    lastSeenAt: null,
    status: null,
    certificate: null,
    certSig: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 计划
// ---------------------------------------------------------------------------

describe('planHubRoleSwitch', () => {
  test('备 Hub 一行：升它自己，原主是当前 writer', () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_X),
      hubs: [hub({ nodeId: HUB_X }), hub({ nodeId: HUB_A, mode: 'active', writerEpoch: 5 })],
      writerHubId: HUB_A,
    });
    expect(plan?.intent).toBe('promote');
    expect(plan?.target?.nodeId).toBe(HUB_X);
    expect(plan?.from?.nodeId).toBe(HUB_A);
    expect(plan?.needsAdmit).toBe(false);
    expect(plan?.fromUnreachable).toBe(false);
    expect(plan?.leavesNoWriter).toBe(false);
  });

  test('目标不是签名授权时须先签一条 admit-hub', () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_X),
      hubs: [hub({ nodeId: HUB_X, authorization: 'env' }), hub({ nodeId: HUB_A, mode: 'active' })],
      writerHubId: HUB_A,
    });
    expect(plan?.needsAdmit).toBe(true);
  });

  test('原主离线：标记不可达，确认框据此提示靠更高纪元围栏', () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_X),
      hubs: [hub({ nodeId: HUB_X }), hub({ nodeId: HUB_A, mode: 'active', online: false })],
      writerHubId: HUB_A,
    });
    expect(plan?.fromUnreachable).toBe(true);
    expect(hubRoleWarnings(t, plan as HubRoleSwitchPlan)).toContain(
      'nodes.hubs.role.warnFromUnreachable'
    );
    // 降备那一步被跳过
    expect(
      hubRoleSteps(t, plan as HubRoleSwitchPlan).some((s) =>
        s.startsWith('nodes.hubs.role.stepDemote(')
      )
    ).toBe(false);
  });

  test('当前写者一行：降它自己，挑一台已授权且在线的 hub 接管', () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_A),
      hubs: [
        hub({ nodeId: HUB_A, mode: 'active' }),
        hub({ nodeId: HUB_C, authorization: 'env', priority: 0 }),
        hub({ nodeId: HUB_X, authorization: 'signed', priority: 9 }),
      ],
      writerHubId: HUB_A,
    });
    expect(plan?.intent).toBe('demote');
    // 签名授权优先于更小的优先级
    expect(plan?.target?.nodeId).toBe(HUB_X);
    expect(plan?.leavesNoWriter).toBe(false);
  });

  test('当前写者一行且没人能接管：允许切换，但警示之后没有可写 Hub', () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_A),
      hubs: [hub({ nodeId: HUB_A, mode: 'active' }), hub({ nodeId: HUB_C, online: false })],
      writerHubId: HUB_A,
    });
    expect(plan?.target).toBeNull();
    expect(plan?.leavesNoWriter).toBe(true);
    expect(hubRoleWarnings(t, plan as HubRoleSwitchPlan)).toContain('nodes.hubs.role.warnNoWriter');
  });

  test('集合里没有这一行时返回 null', () => {
    expect(planHubRoleSwitch({ row: row(HUB_X), hubs: [], writerHubId: null })).toBeNull();
  });

  test('pickSuccessorHub 跳过未授权与离线的候选', () => {
    expect(
      pickSuccessorHub(
        [hub({ nodeId: HUB_C, authorization: undefined }), hub({ nodeId: HUB_X, online: false })],
        HUB_A
      )
    ).toBeNull();
  });
});

describe('hubRoleBlockReason', () => {
  const base = {
    row: row(HUB_X),
    hubs: [hub({ nodeId: HUB_X }), hub({ nodeId: HUB_A, mode: 'active' })],
    writerHubId: HUB_A,
    hubWritable: true,
    switching: false,
    rowBusy: false,
  };

  test('一切正常时可点', () => {
    expect(hubRoleButtonState(base).blocked).toBeNull();
  });

  test('按优先级给出唯一原因：集合未知 → 授权未知 → 离线 → 切换中 → 行忙 → 不收写入', () => {
    expect(hubRoleButtonState({ ...base, hubs: [] }).blocked).toBe('unknownHub');
    expect(
      hubRoleButtonState({ ...base, hubs: [hub({ nodeId: HUB_X, authorization: undefined })] })
        .blocked
    ).toBe('unknownAuth');
    expect(hubRoleButtonState({ ...base, row: row(HUB_X, { online: false }) }).blocked).toBe(
      'offline'
    );
    expect(hubRoleButtonState({ ...base, switching: true }).blocked).toBe('switching');
    expect(hubRoleButtonState({ ...base, rowBusy: true }).blocked).toBe('rowBusy');
  });

  test('只有需要签授权时才卡 hubWritable', () => {
    expect(hubRoleButtonState({ ...base, hubWritable: false }).blocked).toBeNull();
    const needsAdmit = {
      ...base,
      hubs: [
        hub({ nodeId: HUB_X, authorization: 'env' as const }),
        hub({ nodeId: HUB_A, mode: 'active' as const }),
      ],
      hubWritable: false,
    };
    expect(hubRoleButtonState(needsAdmit).blocked).toBe('notWritable');
  });

  test('计划为 null 时不看别的条件', () => {
    expect(hubRoleBlockReason({ ...base, switching: true }, null)).toBe('unknownHub');
  });
});

// ---------------------------------------------------------------------------
// admit-hub 提交
// ---------------------------------------------------------------------------

const RECORD = { bytes: new Uint8Array([1, 2, 3]), sig: new Uint8Array([4, 5]) };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('submitAdmitHubRecord', () => {
  test('hub 确认才算成功', async () => {
    const calls: RequestInit[] = [];
    const outcome = await submitAdmitHubRecord(RECORD, false, async (_path, init) => {
      calls.push(init ?? {});
      return jsonResponse(200, { ok: true, hubAck: true });
    });
    expect(outcome).toEqual({ kind: 'ok' });
    expect((calls[0]?.headers as Record<string, string>)['X-Tmex-Force-Keylog']).toBeUndefined();
  });

  test('hub 没确认时不算成功：一条都没落库，绝不能接着升主', async () => {
    const outcome = await submitAdmitHubRecord(RECORD, false, async () =>
      jsonResponse(200, { ok: true, hubAck: false, hubError: 'HUB_TIMEOUT' })
    );
    expect(outcome).toEqual({ kind: 'failed', code: 'HUB_TIMEOUT' });
  });

  test('409 旧节点：带回 minVersion 与节点清单', async () => {
    const outcome = await submitAdmitHubRecord(RECORD, false, async () =>
      jsonResponse(409, {
        code: KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
        minVersion: '1.1.13',
        nodes: [{ id: 'aa', name: 'laptop', version: '1.1.9' }, { id: 'bb' }, 'junk'],
      })
    );
    expect(outcome.kind).toBe('unsupportedNodes');
    if (outcome.kind !== 'unsupportedNodes') throw new Error('unreachable');
    expect(outcome.minVersion).toBe('1.1.13');
    expect(outcome.nodes).toEqual([
      { id: 'aa', name: 'laptop', version: '1.1.9' },
      { id: 'bb', name: 'bb', version: null },
    ]);
  });

  test('force 时补上强制头', async () => {
    const headers: Array<Record<string, string>> = [];
    await submitAdmitHubRecord(RECORD, true, async (_path, init) => {
      headers.push(init?.headers as Record<string, string>);
      return jsonResponse(200, { ok: true, hubAck: true });
    });
    expect(headers[0]?.['X-Tmex-Force-Keylog']).toBe('1');
  });

  test('网络异常与其它错误码原样带出', async () => {
    expect(
      await submitAdmitHubRecord(RECORD, false, () => Promise.reject(new Error('boom')))
    ).toEqual({ kind: 'failed', code: 'NODE_UNREACHABLE' });
    expect(
      await submitAdmitHubRecord(RECORD, false, async () => jsonResponse(409, { code: 'seq_gap' }))
    ).toEqual({ kind: 'failed', code: 'seq_gap' });
  });
});

describe('admitHubWithForce', () => {
  test('没被挡住时不问用户', async () => {
    let asked = 0;
    const outcome = await admitHubWithForce({
      submit: async () => ({ kind: 'ok' }) as AdmitHubOutcome,
      confirmForce: async () => {
        asked += 1;
        return true;
      },
    });
    expect(outcome).toEqual({ kind: 'ok' });
    expect(asked).toBe(0);
  });

  test('被旧节点挡住 → 勾了「仍然继续」才重发一次强制请求', async () => {
    const forces: boolean[] = [];
    const outcome = await admitHubWithForce({
      submit: async (force) => {
        forces.push(force);
        return force
          ? ({ kind: 'ok' } as AdmitHubOutcome)
          : ({ kind: 'unsupportedNodes', minVersion: '1.1.13', nodes: [] } as AdmitHubOutcome);
      },
      confirmForce: async () => true,
    });
    expect(forces).toEqual([false, true]);
    expect(outcome).toEqual({ kind: 'ok' });
  });

  test('用户不勾就取消，不重发', async () => {
    const forces: boolean[] = [];
    const outcome = await admitHubWithForce({
      submit: async (force) => {
        forces.push(force);
        return { kind: 'unsupportedNodes', minVersion: '1.1.13', nodes: [] };
      },
      confirmForce: async () => false,
    });
    expect(forces).toEqual([false]);
    expect(outcome).toEqual({ kind: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

interface FakeIoOptions {
  role?: (hubNodeId: string, mode: string) => HubRoleOutcome;
  /** 每次 `roleStatus` 依次取一个；用完后停在最后一个。 */
  statuses?: HubRoleOutcome[];
  hubs?: () => { hubs: MeshHubEndpoint[]; writerHubId: string | null };
  admit?: AdmitHubOutcome;
}

interface FakeIo extends HubRoleIo {
  calls: Array<{ hubNodeId: string; mode: string; writerEpoch?: number; operationId: string }>;
  /** 原样留一份请求体：验证「升主不带 writerEpoch」要看键在不在，不能看值。 */
  requests: HubRoleRequest[];
  admits: boolean[];
  clock: { value: number };
}

function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const clock = { value: 1_000 };
  const calls: FakeIo['calls'] = [];
  const requests: HubRoleRequest[] = [];
  const admits: boolean[] = [];
  let index = 0;
  const io: FakeIo = {
    calls,
    requests,
    admits,
    clock,
    async appendAdmitHub(_record, force) {
      admits.push(force);
      return options.admit ?? { kind: 'ok' };
    },
    async role(hubNodeId, req) {
      requests.push(req);
      calls.push({
        hubNodeId,
        mode: req.mode,
        writerEpoch: req.writerEpoch,
        operationId: req.operationId,
      });
      return options.role?.(hubNodeId, req.mode) ?? { kind: 'ok', phase: 'accepted', error: null };
    },
    async roleStatus() {
      const list = options.statuses ?? [{ kind: 'ok', phase: 'complete', error: null }];
      const next = list[Math.min(index, list.length - 1)] as HubRoleOutcome;
      index += 1;
      return next;
    },
    async hubs() {
      return options.hubs?.() ?? { hubs: [], writerHubId: HUB_X };
    },
    async wait(ms) {
      clock.value += ms;
      return true;
    },
    now: () => clock.value,
  };
  return io;
}

function promotePlan(overrides: Partial<HubRoleSwitchPlan> = {}): HubRoleSwitchPlan {
  const plan = planHubRoleSwitch({
    row: row(HUB_X),
    hubs: [hub({ nodeId: HUB_X }), hub({ nodeId: HUB_A, mode: 'active', writerEpoch: 5 })],
    writerHubId: HUB_A,
  }) as HubRoleSwitchPlan;
  return { ...plan, ...overrides };
}

const NEVER_ADMIT = () => Promise.reject(new Error('admit should not be called'));

/** 记下每一次续跑记录的 phase，用来验证「改动请求发出去之前先落盘」。 */
function persistSpy(): {
  phases: HubRoleResumePhase[];
  persist: (phase: HubRoleResumePhase) => void;
} {
  const phases: HubRoleResumePhase[] = [];
  return { phases, persist: (phase) => phases.push(phase) };
}

describe('runHubRoleSwitch', () => {
  test('目标已签名授权：跳过 admit，先降原主再升目标，最后确认 writer 换人', async () => {
    const io = fakeIo();
    const phases: string[] = [];
    const saved = persistSpy();
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-1',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: (phase) => phases.push(phase),
      persist: saved.persist,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.admits).toEqual([]);
    expect(io.calls).toEqual([
      { hubNodeId: HUB_A, mode: 'standby', writerEpoch: undefined, operationId: 'op-1' },
      { hubNodeId: HUB_X, mode: 'active', writerEpoch: undefined, operationId: 'op-1' },
    ]);
    expect(phases).toEqual(['demoting', 'promoting', 'restarting', 'awaitingWriter']);
    // 每一个改动请求之前都先落一次盘，最后一档是「只剩回读」。
    expect(saved.phases).toEqual(['demote', 'promote', 'wait']);
  });

  test('升主请求不带 writerEpoch：纪元由目标自己分配', async () => {
    const io = fakeIo();
    await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-epoch',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    const promote = io.requests.find((req) => req.mode === 'active');
    expect(promote).toBeDefined();
    expect(Object.keys(promote as object)).toEqual(['mode', 'operationId']);
  });

  test('目标仍回 HUB_EPOCH_STALE：原样重发一次让它重新取号', async () => {
    let actives = 0;
    const io = fakeIo({
      role: (_id, mode) => {
        if (mode !== 'active') return { kind: 'ok', phase: 'accepted', error: null };
        actives += 1;
        return actives === 1
          ? { kind: 'failed', code: 'HUB_EPOCH_STALE' }
          : { kind: 'ok', phase: 'accepted', error: null };
      },
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-stale',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(actives).toBe(2);
  });

  test('重发后还是 stale：报出去，不再无限重试', async () => {
    const io = fakeIo({
      role: (_id, mode) =>
        mode === 'active'
          ? { kind: 'failed', code: 'HUB_EPOCH_STALE' }
          : { kind: 'ok', phase: 'accepted', error: null },
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-stale2',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('recover');
    expect(io.calls.filter((call) => call.mode === 'active')).toHaveLength(2);
  });

  test('需要签授权：先落盘 admit，再 admit，等 /api/mesh/hubs 出现 signed 才往下走', async () => {
    let hubCalls = 0;
    const io = fakeIo({
      hubs: () => {
        hubCalls += 1;
        // 第一拍还没生效，第二拍才 signed；随后 writer 换成目标。
        return {
          hubs: [hub({ nodeId: HUB_X, authorization: hubCalls >= 2 ? 'signed' : 'env' })],
          writerHubId: hubCalls >= 3 ? HUB_X : HUB_A,
        };
      },
    });
    const admitted: string[] = [];
    const phases: string[] = [];
    const saved = persistSpy();
    const outcome = await runHubRoleSwitch({
      plan: promotePlan({ needsAdmit: true }),
      operationId: 'op-2',
      io,
      signal: new AbortController().signal,
      admit: async (target) => {
        admitted.push(target.nodeId);
        return { kind: 'ok' };
      },
      phase: (phase) => phases.push(phase),
      persist: saved.persist,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(admitted).toEqual([HUB_X]);
    expect(phases.slice(0, 2)).toEqual(['admitting', 'awaitingAuth']);
    expect(saved.phases).toEqual(['admit', 'demote', 'promote', 'wait']);
    expect(hubCalls).toBeGreaterThanOrEqual(2);
  });

  test('用户在凭据框取消：什么都不发', async () => {
    const io = fakeIo();
    const outcome = await runHubRoleSwitch({
      plan: promotePlan({ needsAdmit: true }),
      operationId: 'op-3',
      io,
      signal: new AbortController().signal,
      admit: async () => ({ kind: 'cancelled' }),
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'cancelled' });
    expect(io.calls).toEqual([]);
  });

  test('授权迟迟不生效：判失败，不接着升主', async () => {
    const io = fakeIo({
      hubs: () => ({ hubs: [hub({ nodeId: HUB_X, authorization: 'env' })], writerHubId: HUB_A }),
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan({ needsAdmit: true }),
      operationId: 'op-4',
      io,
      signal: new AbortController().signal,
      admit: async () => ({ kind: 'ok' }),
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'nodes.hubs.role.errors.authTimeout',
    });
    expect(io.calls).toEqual([]);
  });

  test('原主不可达：跳过降备，只发升主', async () => {
    const io = fakeIo();
    const outcome = await runHubRoleSwitch({
      plan: promotePlan({ fromUnreachable: true }),
      operationId: 'op-5',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls.map((call) => call.hubNodeId)).toEqual([HUB_X]);
  });

  test('降备被目标拒绝：就地失败，不带着一台仍在写的旧主继续', async () => {
    const io = fakeIo({
      role: (_id, mode) =>
        mode === 'standby'
          ? { kind: 'failed', code: 'HUB_ROLE_BUSY' }
          : { kind: 'ok', phase: 'accepted', error: null },
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-6',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('failed');
    expect(io.calls).toHaveLength(1);
  });

  test('原主已降备而升主被拒：给出恢复上下文，不只弹一条 toast', async () => {
    const io = fakeIo({
      role: (_id, mode) =>
        mode === 'active'
          ? { kind: 'failed', code: 'HUB_NOT_AUTHORIZED' }
          : { kind: 'ok', phase: 'accepted', error: null },
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-7',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({
      kind: 'recover',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      message: t('nodes.hubs.role.failed', {
        error: 'nodes.hubs.role.errors.HUB_NOT_AUTHORIZED',
      }),
    });
  });

  test('目标回读自报 failed：同样走恢复，集群此刻没有 writer', async () => {
    const io = fakeIo({ statuses: [{ kind: 'ok', phase: 'failed', error: 'HUB_NOT_HUB' }] });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-7b',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('recover');
  });

  test('原主不可达时升主被拒：普通失败，没有可回滚的原主', async () => {
    const io = fakeIo({
      role: () => ({ kind: 'failed', code: 'HUB_NOT_AUTHORIZED' }),
    });
    const outcome = await runHubRoleSwitch({
      plan: promotePlan({ fromUnreachable: true }),
      operationId: 'op-7c',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('failed');
  });

  test('只降备、无人接管：一条 standby 就收尾，落盘也只有 demote', async () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_A),
      hubs: [hub({ nodeId: HUB_A, mode: 'active' })],
      writerHubId: HUB_A,
    }) as HubRoleSwitchPlan;
    const io = fakeIo();
    const saved = persistSpy();
    const outcome = await runHubRoleSwitch({
      plan,
      operationId: 'op-9',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      persist: saved.persist,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([
      { hubNodeId: HUB_A, mode: 'standby', writerEpoch: undefined, operationId: 'op-9' },
    ]);
    expect(saved.phases).toEqual(['demote']);
  });
});

describe('promoteHub（恢复对话框里的两个按钮走的就是它）', () => {
  test('重试目标失败：恢复上下文原样带回，用户还能再选一次', async () => {
    const io = fakeIo({ role: () => ({ kind: 'failed', code: 'HUB_ROLE_BUSY' }) });
    const outcome = await promoteHub({
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
      operationId: 'op-retry',
      targetHubId: HUB_X,
      recover: { targetHubId: HUB_X, fromHubId: HUB_A },
    });
    expect(outcome).toEqual({
      kind: 'recover',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      message: t('nodes.hubs.role.failed', { error: 'nodes.hubs.role.errors.HUB_ROLE_BUSY' }),
    });
  });

  test('回滚：升的是原主，成功后按原主确认 writer 换人', async () => {
    const io = fakeIo({ hubs: () => ({ hubs: [], writerHubId: HUB_A }) });
    const saved = persistSpy();
    const outcome = await promoteHub({
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      persist: saved.persist,
      t,
      operationId: 'op-rollback',
      targetHubId: HUB_A,
      recover: { targetHubId: HUB_X, fromHubId: HUB_A },
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([
      { hubNodeId: HUB_A, mode: 'active', writerEpoch: undefined, operationId: 'op-rollback' },
    ]);
    expect(saved.phases).toEqual(['promote', 'wait']);
  });
});

describe('awaitHubRoleSwitch', () => {
  test('目标重启期间的不可达按「重启中」继续等，起来后读到 complete', async () => {
    const io = fakeIo({
      statuses: [
        { kind: 'unreachable' },
        { kind: 'failed', code: 'HUB_ROLE_UNSUPPORTED' },
        { kind: 'ok', phase: 'restarting', error: null },
        { kind: 'ok', phase: 'complete', error: null },
      ],
    });
    const phases: string[] = [];
    const outcome = await awaitHubRoleSwitch({
      targetHubId: HUB_X,
      operationId: 'op-a',
      io,
      signal: new AbortController().signal,
      phase: (phase) => phases.push(phase),
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(phases).toEqual(['restarting', 'awaitingWriter']);
  });

  test('连不上超出预算：不谎报成功，报「未确认」', async () => {
    const io = fakeIo({ statuses: [{ kind: 'failed', code: 'HUB_ROLE_UNSUPPORTED' }] });
    const outcome = await awaitHubRoleSwitch({
      targetHubId: HUB_X,
      operationId: 'op-b',
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('unconfirmed');
    expect(io.clock.value).toBeGreaterThanOrEqual(1000 + HUB_ROLE_RESTART_BUDGET_MS);
  });

  test('目标自报 failed：原样报出错误', async () => {
    const io = fakeIo({ statuses: [{ kind: 'ok', phase: 'failed', error: 'HUB_NOT_AUTHORIZED' }] });
    const outcome = await awaitHubRoleSwitch({
      targetHubId: HUB_X,
      operationId: 'op-c',
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      message: t('nodes.hubs.role.failed', {
        error: 'nodes.hubs.role.errors.HUB_NOT_AUTHORIZED',
      }),
    });
  });

  test('writer 迟迟不换人：报「未确认」，让用户自己刷新核对', async () => {
    const io = fakeIo({ hubs: () => ({ hubs: [], writerHubId: HUB_A }) });
    const outcome = await awaitHubRoleSwitch({
      targetHubId: HUB_X,
      operationId: 'op-d',
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({
      kind: 'unconfirmed',
      message: 'nodes.hubs.role.errors.writerTimeout',
    });
    expect(io.clock.value).toBeGreaterThanOrEqual(1000 + HUB_ROLE_WRITER_TIMEOUT_MS);
  });

  test('组件卸载：立刻收摊，不再轮询', async () => {
    const controller = new AbortController();
    controller.abort();
    const io = fakeIo();
    expect(
      await awaitHubRoleSwitch({
        targetHubId: HUB_X,
        operationId: 'op-e',
        io,
        signal: controller.signal,
        phase: () => undefined,
        t,
      })
    ).toEqual({ kind: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// 断点续跑
// ---------------------------------------------------------------------------

const savedDescriptor = new Map<string, PropertyDescriptor | undefined>();

function installSession(store: Storage | null): void {
  if (!savedDescriptor.has('sessionStorage')) {
    savedDescriptor.set(
      'sessionStorage',
      Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    );
  }
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: store,
    configurable: true,
    writable: true,
  });
}

describe('续跑记录', () => {
  beforeEach(() => installSession(createMemoryStorage()));
  afterEach(() => {
    for (const [key, descriptor] of savedDescriptor) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    savedDescriptor.clear();
  });

  function record(overrides: Partial<HubRoleSwitchRecord> = {}): HubRoleSwitchRecord {
    return {
      operationId: 'op-1',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      intent: 'switch',
      phase: 'wait',
      startedAt: 1000,
      ...overrides,
    };
  }

  test('写入后能读回；清除后为空', () => {
    saveHubRoleSwitch(record());
    expect(globalThis.sessionStorage.getItem(HUB_ROLE_SWITCH_KEY)).toContain('op-1');
    expect(loadHubRoleSwitch(2000)).toEqual(record());
    clearHubRoleSwitch();
    expect(loadHubRoleSwitch(2000)).toBeNull();
  });

  test('每一步都往同一条记录上更新 phase，其余字段不变', () => {
    const persist = hubRoleSwitchPersist({
      operationId: 'op-p',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      intent: 'switch',
      startedAt: 1000,
    });
    persist('admit');
    expect(loadHubRoleSwitch(1000)?.phase).toBe('admit');
    persist('promote');
    const saved = loadHubRoleSwitch(1000);
    expect(saved?.phase).toBe('promote');
    expect(saved?.operationId).toBe('op-p');
    expect(saved?.fromHubId).toBe(HUB_A);
  });

  test('过期的记录连同存储一并丢掉', () => {
    saveHubRoleSwitch(record({ operationId: 'op-2', fromHubId: null, startedAt: 0 }));
    expect(loadHubRoleSwitch(HUB_ROLE_SWITCH_TTL_MS + 1)).toBeNull();
    expect(globalThis.sessionStorage.getItem(HUB_ROLE_SWITCH_KEY)).toBeNull();
  });

  test('脏数据一律丢掉', () => {
    for (const raw of ['{', 'null', '[]', '{"operationId":1}', '{"operationId":"x"}']) {
      globalThis.sessionStorage.setItem(HUB_ROLE_SWITCH_KEY, raw);
      expect(loadHubRoleSwitch(1000)).toBeNull();
    }
  });

  test('认不出的 phase / intent 退到最保守的一档：只回读，不重发', () => {
    globalThis.sessionStorage.setItem(
      HUB_ROLE_SWITCH_KEY,
      JSON.stringify({ operationId: 'op-x', targetHubId: HUB_X, startedAt: 1000, phase: 'junk' })
    );
    const loaded = loadHubRoleSwitch(1000);
    expect(loaded?.phase).toBe('wait');
    expect(loaded?.intent).toBe('switch');
    expect(loaded?.fromHubId).toBeNull();
  });

  test('没有 sessionStorage（隐私模式）时读写都不抛', () => {
    installSession(null);
    expect(() => saveHubRoleSwitch(record({ fromHubId: null }))).not.toThrow();
    expect(loadHubRoleSwitch(1)).toBeNull();
  });
});

describe('resumeHubRoleSwitch', () => {
  test('phase=wait：只回读第 4 步，不重发任何 role 请求', async () => {
    const io = fakeIo({
      statuses: [{ kind: 'unreachable' }, { kind: 'ok', phase: 'complete', error: null }],
    });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-4',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'wait',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([]);
  });

  test('phase=wait 且目标自报 failed：原主已降备，走恢复而不是干失败', async () => {
    const io = fakeIo({ statuses: [{ kind: 'ok', phase: 'failed', error: 'HUB_NOT_HUB' }] });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-4b',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'wait',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome.kind).toBe('recover');
  });

  test('phase=demote 且原主还在写：重发降备（同一个 operationId），再升目标', async () => {
    const io = fakeIo({ hubs: () => ({ hubs: [], writerHubId: HUB_A }) });
    const saved = persistSpy();
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-5',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'demote',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      persist: saved.persist,
      t,
    });
    // hubs() 一直回 HUB_A：升主后等不到 writer 换人，结论是「未确认」而不是谎报成功。
    expect(outcome.kind).toBe('unconfirmed');
    expect(io.calls.map((call) => [call.hubNodeId, call.mode, call.operationId])).toEqual([
      [HUB_A, 'standby', 'op-5'],
      [HUB_X, 'active', 'op-5'],
    ]);
    expect(saved.phases).toEqual(['demote', 'promote', 'wait']);
  });

  test('phase=promote 且原主已是备：跳过降备，直接重发升主', async () => {
    let hubCalls = 0;
    const io = fakeIo({
      hubs: () => {
        hubCalls += 1;
        return { hubs: [], writerHubId: hubCalls === 1 ? null : HUB_X };
      },
    });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-6',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'promote',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls.map((call) => call.mode)).toEqual(['active']);
  });

  test('phase=promote 但 writer 已经是目标：刷新前那一段其实跑完了', async () => {
    const io = fakeIo({ hubs: () => ({ hubs: [], writerHubId: HUB_X }) });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-7',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'promote',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([]);
  });

  test('phase=admit 且授权已签成：接着降备升主', async () => {
    let hubCalls = 0;
    const io = fakeIo({
      hubs: () => {
        hubCalls += 1;
        return {
          hubs: [hub({ nodeId: HUB_X, authorization: 'signed' })],
          writerHubId: hubCalls === 1 ? HUB_A : HUB_X,
        };
      },
    });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-8',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'admit',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls.map((call) => call.mode)).toEqual(['standby', 'active']);
  });

  test('phase=admit 但授权还没签成：收摊，重签要用户凭据不能替他按下去', async () => {
    const io = fakeIo({
      hubs: () => ({
        hubs: [hub({ nodeId: HUB_X, authorization: 'env' })],
        writerHubId: HUB_A,
      }),
    });
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-9',
        targetHubId: HUB_X,
        fromHubId: HUB_A,
        intent: 'switch',
        phase: 'admit',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({
      kind: 'failed',
      message: 'nodes.hubs.role.errors.resumeAdmit',
    });
    expect(io.calls).toEqual([]);
  });

  test('只降备那一路：重发一次幂等的 standby 就收尾，绝不升主', async () => {
    const io = fakeIo();
    const outcome = await resumeHubRoleSwitch({
      record: {
        operationId: 'op-10',
        targetHubId: HUB_A,
        fromHubId: null,
        intent: 'demoteOnly',
        phase: 'demote',
        startedAt: 1000,
      },
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls.map((call) => call.mode)).toEqual(['standby']);
  });
});

describe('operationId', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('手搓的 v4 合法：版本位与变体位都补上，后端正则收得下', () => {
    for (let i = 0; i < 64; i += 1) expect(randomUuidV4()).toMatch(UUID_V4);
    expect(new Set(Array.from({ length: 32 }, () => randomUuidV4())).size).toBe(32);
  });

  test('非安全上下文没有 randomUUID：退到手搓的 v4，仍然合法', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    // 只留 getRandomValues：这正是 http:// 局域网入口下的样子。
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) },
      configurable: true,
      writable: true,
    });
    try {
      expect(randomOperationId()).toMatch(UUID_V4);
      expect(randomUuidV4()).toBe('07070707-0707-4707-8707-070707070707');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  test('连 getRandomValues 都没有时也不抛，照样出一个合法 UUID', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      expect(randomOperationId()).toMatch(UUID_V4);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });
});
