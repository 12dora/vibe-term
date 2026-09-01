// Hub 主备切换的编排：计划、按钮态、`admit-hub` 的强制路径、跨重启的轮询与断点续跑。
// 全部走注入的假 io / 假 fetch，不碰网络与真实计时器。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NodeRow } from '@/node/mesh-nodes';
import type { MeshHubEndpoint } from '@tmex/api-client/auth/index';
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
  type HubRoleSwitchPlan,
  admitHubWithForce,
  awaitHubRoleSwitch,
  clearHubRoleSwitch,
  hubRoleBlockReason,
  hubRoleButtonState,
  hubRoleSteps,
  hubRoleWarnings,
  loadHubRoleSwitch,
  nextWriterEpoch,
  pickSuccessorHub,
  planHubRoleSwitch,
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
  test('纪元取集合最大值 + 1；空集合从 1 起', () => {
    expect(nextWriterEpoch([])).toBe(1);
    expect(
      nextWriterEpoch([
        hub({ nodeId: HUB_X, writerEpoch: 2 }),
        hub({ nodeId: HUB_A, writerEpoch: 7 }),
      ])
    ).toBe(8);
  });

  test('备 Hub 一行：升它自己，原主是当前 writer，纪元 +1', () => {
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
    expect(plan?.newEpoch).toBe(6);
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
  admits: boolean[];
  clock: { value: number };
}

function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const clock = { value: 1_000 };
  const calls: FakeIo['calls'] = [];
  const admits: boolean[] = [];
  let index = 0;
  const io: FakeIo = {
    calls,
    admits,
    clock,
    async appendAdmitHub(_record, force) {
      admits.push(force);
      return options.admit ?? { kind: 'ok' };
    },
    async role(hubNodeId, req) {
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

describe('runHubRoleSwitch', () => {
  test('目标已签名授权：跳过 admit，先降原主再升目标，最后确认 writer 换人', async () => {
    const io = fakeIo();
    const phases: string[] = [];
    const outcome = await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-1',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: (phase) => phases.push(phase),
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.admits).toEqual([]);
    expect(io.calls).toEqual([
      { hubNodeId: HUB_A, mode: 'standby', writerEpoch: undefined, operationId: 'op-1' },
      { hubNodeId: HUB_X, mode: 'active', writerEpoch: 6, operationId: 'op-1' },
    ]);
    expect(phases).toEqual(['demoting', 'promoting', 'restarting', 'awaitingWriter']);
  });

  test('需要签授权：先 admit，等 /api/mesh/hubs 出现 signed 再往下走', async () => {
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
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(admitted).toEqual([HUB_X]);
    expect(phases.slice(0, 2)).toEqual(['admitting', 'awaitingAuth']);
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

  test('升主被拒：错误码走文案表', async () => {
    const io = fakeIo({
      role: (_id, mode) =>
        mode === 'active'
          ? { kind: 'failed', code: 'HUB_EPOCH_STALE' }
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
      kind: 'failed',
      message: t('nodes.hubs.role.failed', {
        error: 'nodes.hubs.role.errors.HUB_EPOCH_STALE',
      }),
    });
  });

  test('受理后落一条续跑记录', async () => {
    const io = fakeIo();
    let saved = 0;
    await runHubRoleSwitch({
      plan: promotePlan(),
      operationId: 'op-8',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      onAccepted: () => {
        saved += 1;
      },
      t,
    });
    expect(saved).toBe(1);
  });

  test('只降备、无人接管：一条 standby 就收尾', async () => {
    const plan = planHubRoleSwitch({
      row: row(HUB_A),
      hubs: [hub({ nodeId: HUB_A, mode: 'active' })],
      writerHubId: HUB_A,
    }) as HubRoleSwitchPlan;
    const io = fakeIo();
    const outcome = await runHubRoleSwitch({
      plan,
      operationId: 'op-9',
      io,
      signal: new AbortController().signal,
      admit: NEVER_ADMIT,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([
      { hubNodeId: HUB_A, mode: 'standby', writerEpoch: undefined, operationId: 'op-9' },
    ]);
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

  test('写入后能读回；清除后为空', () => {
    saveHubRoleSwitch({
      operationId: 'op-1',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      startedAt: 1000,
    });
    expect(globalThis.sessionStorage.getItem(HUB_ROLE_SWITCH_KEY)).toContain('op-1');
    expect(loadHubRoleSwitch(2000)).toEqual({
      operationId: 'op-1',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      startedAt: 1000,
    });
    clearHubRoleSwitch();
    expect(loadHubRoleSwitch(2000)).toBeNull();
  });

  test('过期的记录连同存储一并丢掉', () => {
    saveHubRoleSwitch({ operationId: 'op-2', targetHubId: HUB_X, fromHubId: null, startedAt: 0 });
    expect(loadHubRoleSwitch(HUB_ROLE_SWITCH_TTL_MS + 1)).toBeNull();
    expect(globalThis.sessionStorage.getItem(HUB_ROLE_SWITCH_KEY)).toBeNull();
  });

  test('脏数据一律丢掉', () => {
    for (const raw of ['{', 'null', '[]', '{"operationId":1}', '{"operationId":"x"}']) {
      globalThis.sessionStorage.setItem(HUB_ROLE_SWITCH_KEY, raw);
      expect(loadHubRoleSwitch(1000)).toBeNull();
    }
  });

  test('没有 sessionStorage（隐私模式）时读写都不抛', () => {
    installSession(null);
    expect(() =>
      saveHubRoleSwitch({ operationId: 'op-3', targetHubId: HUB_X, fromHubId: null, startedAt: 1 })
    ).not.toThrow();
    expect(loadHubRoleSwitch(1)).toBeNull();
  });

  test('刷新后接上第 4 步：只轮询目标，不重发任何 role 请求', async () => {
    saveHubRoleSwitch({
      operationId: 'op-4',
      targetHubId: HUB_X,
      fromHubId: HUB_A,
      startedAt: 1000,
    });
    const record = loadHubRoleSwitch(2000);
    expect(record).not.toBeNull();
    const io = fakeIo({
      statuses: [{ kind: 'unreachable' }, { kind: 'ok', phase: 'complete', error: null }],
    });
    const outcome = await awaitHubRoleSwitch({
      targetHubId: (record as NonNullable<typeof record>).targetHubId,
      operationId: (record as NonNullable<typeof record>).operationId,
      io,
      signal: new AbortController().signal,
      phase: () => undefined,
      t,
    });
    expect(outcome).toEqual({ kind: 'done' });
    expect(io.calls).toEqual([]);
  });
});
