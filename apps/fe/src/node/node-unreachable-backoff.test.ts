import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@vibeterm/api-client';
import { HubApiError } from './hub-api';
import {
  BACKOFF_FIRST_MS,
  BACKOFF_HARD_FIRST_MS,
  BACKOFF_MAX_MS,
  NodeBackoffSkippedError,
  clearAllNodeBackoff,
  isNodeRequestBlocked,
  isUnreachableFailure,
  nodeBackoffRemainingMs,
  nodeUnreachableReason,
  noteMeshNodesOnline,
  noteNodeQueryErrorAt,
  noteNodeQuerySuccessAt,
  noteNodeRequestOutcome,
  noteNodeUnreachable,
  setNodeBackoffTimersForTest,
  subscribeNodeBackoff,
  unreachableBackoffKind,
} from './node-unreachable-backoff';

const NODE_A = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const NODE_B = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

interface FakeClock {
  advance: (ms: number) => void;
  delays: number[];
}

function installClock(): FakeClock {
  let now = 0;
  let nextId = 1;
  const delays: number[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  setNodeBackoffTimersForTest({
    schedule: (fn, ms) => {
      delays.push(ms);
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (handle) => {
      timers.delete(handle as number);
    },
    now: () => now,
    random: () => 0,
  });
  return {
    delays,
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

let clock: FakeClock;

beforeEach(() => {
  clock = installClock();
});

afterEach(() => {
  setNodeBackoffTimersForTest(null);
});

describe('isUnreachableFailure', () => {
  test('转发器的 503 NODE_UNREACHABLE 算', () => {
    expect(
      isUnreachableFailure(new ApiError(503, 'unreachable', { code: 'NODE_UNREACHABLE' }))
    ).toBe(true);
  });

  test('服务端应答过的业务错误不算', () => {
    expect(isUnreachableFailure(new ApiError(401, 'x', { code: 'NODE_LOGIN_REQUIRED' }))).toBe(
      false
    );
    expect(isUnreachableFailure(new ApiError(500, 'boom'))).toBe(false);
    expect(isUnreachableFailure(new ApiError(404, 'nope'))).toBe(false);
  });

  test('带 status 的自定义错误（HubApiError 那类）同样不算', () => {
    expect(isUnreachableFailure(new HubApiError('hub_nodes_failed', 500))).toBe(false);
    expect(isUnreachableFailure(new HubApiError('NODE_LOGIN_REQUIRED', 401))).toBe(false);
    // 除非它明确说了「打不通」
    expect(isUnreachableFailure(new HubApiError('NODE_UNREACHABLE', 503))).toBe(true);
  });

  test('传输层异常与超时算，主动取消不算，空值不算', () => {
    expect(isUnreachableFailure(new TypeError('Failed to fetch'))).toBe(true);
    const timedOut = new Error('timeout');
    timedOut.name = 'TimeoutError';
    expect(isUnreachableFailure(timedOut)).toBe(true);
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(isUnreachableFailure(aborted)).toBe(false);
    expect(isUnreachableFailure(null)).toBe(false);
    expect(isUnreachableFailure(undefined)).toBe(false);
  });

  test('退避门自己短路出来的错误不构成新的失败', () => {
    expect(isUnreachableFailure(new NodeBackoffSkippedError(NODE_A))).toBe(false);
    noteNodeRequestOutcome(NODE_A, new NodeBackoffSkippedError(NODE_A));
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });
});

describe('每 node 退避', () => {
  test('一次打不通即进入退避，到期自动放行', () => {
    noteNodeUnreachable(NODE_A);
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
    clock.advance(BACKOFF_FIRST_MS - 1);
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
    clock.advance(1);
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('连续失败逐次翻倍并封顶 10 分钟', () => {
    for (let i = 0; i < 12; i++) {
      noteNodeUnreachable(NODE_A);
      clock.advance(BACKOFF_MAX_MS);
    }
    expect(clock.delays.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(clock.delays.at(-1)).toBe(BACKOFF_MAX_MS);
  });

  test('503 timeout 走 2–5s 短退避；no_link 走更长的硬退避', () => {
    noteNodeUnreachable(
      NODE_A,
      new ApiError(503, 'unreachable', { code: 'NODE_UNREACHABLE', reason: 'timeout' })
    );
    expect(clock.delays[0]).toBe(BACKOFF_FIRST_MS);
    expect(nodeUnreachableReason(NODE_A)).toBe('timeout');

    noteNodeUnreachable(
      NODE_B,
      new ApiError(503, 'unreachable', { code: 'NODE_UNREACHABLE', reason: 'no_link' })
    );
    expect(clock.delays[1]).toBe(BACKOFF_HARD_FIRST_MS);
    expect(nodeUnreachableReason(NODE_B)).toBe('no_link');
  });

  test('短路错误带上最近一次 reason，给已有 UI 的 {{reason}} 插值', () => {
    noteNodeUnreachable(
      NODE_A,
      new ApiError(503, 'unreachable', { code: 'NODE_UNREACHABLE', reason: 'timeout' })
    );
    const skipped = new NodeBackoffSkippedError(NODE_A);
    expect(skipped.reason).toBe('timeout');
    expect(skipped.status).toBe(503);
    expect(skipped.code).toBe('NODE_UNREACHABLE');
  });

  test('退避按 node 隔离', () => {
    noteNodeUnreachable(NODE_A);
    expect(isNodeRequestBlocked(NODE_B)).toBe(false);
  });

  test('又成功一次即解除，失败计数一并归零', () => {
    noteNodeUnreachable(NODE_A);
    noteNodeUnreachable(NODE_A);
    noteNodeRequestOutcome(NODE_A, null);
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
    const before = clock.delays.length;
    noteNodeUnreachable(NODE_A);
    expect(clock.delays[before]).toBe(BACKOFF_FIRST_MS);
  });

  test('业务错误不进退避', () => {
    noteNodeRequestOutcome(NODE_A, new ApiError(401, 'x', { code: 'NODE_LOGIN_REQUIRED' }));
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('查询水位前进才解除，同一份数据的重复挂载不解除', () => {
    noteNodeQuerySuccessAt(NODE_A, 100);
    noteNodeUnreachable(NODE_A);
    noteNodeQuerySuccessAt(NODE_A, 100);
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
    noteNodeQuerySuccessAt(NODE_A, 200);
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('列表报出「离线 → 在线」的转变才解除；一直报在线不解除', () => {
    noteNodeUnreachable(NODE_A);
    noteMeshNodesOnline([{ id: NODE_A, online: true }], [{ id: NODE_A, online: true }]);
    expect(isNodeRequestBlocked(NODE_A)).toBe(true);
    noteMeshNodesOnline([{ id: NODE_A, online: false }], [{ id: NODE_A, online: true }]);
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('列表里新出现且在线的 node 同样解除', () => {
    noteNodeUnreachable(NODE_A);
    noteMeshNodesOnline([], [{ id: NODE_A, online: true }]);
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
  });

  test('状态变化通知订阅者（进入与到期各一次）', () => {
    let calls = 0;
    const stop = subscribeNodeBackoff(() => {
      calls += 1;
    });
    noteNodeUnreachable(NODE_A);
    expect(calls).toBe(1);
    clock.advance(BACKOFF_FIRST_MS);
    expect(calls).toBe(2);
    stop();
  });

  test('clearAllNodeBackoff 放行全部 node', () => {
    noteNodeUnreachable(NODE_A);
    noteNodeUnreachable(NODE_B);
    clearAllNodeBackoff();
    expect(isNodeRequestBlocked(NODE_A)).toBe(false);
    expect(isNodeRequestBlocked(NODE_B)).toBe(false);
  });
});

describe('self 豁免', () => {
  test('entry 自身永远不进退避（网关重启不该挡住本机设备列表）', () => {
    noteNodeUnreachable('self');
    expect(isNodeRequestBlocked('self')).toBe(false);
    noteNodeRequestOutcome('self', new TypeError('Failed to fetch'));
    expect(isNodeRequestBlocked('self')).toBe(false);
    // 空 nodeId 同样按 self 处理
    noteNodeUnreachable('');
    expect(isNodeRequestBlocked('')).toBe(false);
  });
});

describe('失败水位', () => {
  test('同一次失败（errorUpdatedAt 不变）只记一次，重挂不会把退避翻倍', () => {
    const error = new TypeError('Failed to fetch');
    noteNodeQueryErrorAt(NODE_A, error, 100);
    const first = nodeBackoffRemainingMs(NODE_A);
    noteNodeQueryErrorAt(NODE_A, error, 100);
    expect(nodeBackoffRemainingMs(NODE_A)).toBe(first);
    expect(first).toBe(BACKOFF_FIRST_MS);
  });

  test('水位前进才算新的一次失败', () => {
    const error = new TypeError('Failed to fetch');
    noteNodeQueryErrorAt(NODE_A, error, 100);
    noteNodeQueryErrorAt(NODE_A, error, 200);
    expect(nodeBackoffRemainingMs(NODE_A)).toBe(BACKOFF_FIRST_MS * 2);
  });

  test('nodeBackoffRemainingMs 随时间递减，退避解除后归零', () => {
    noteNodeUnreachable(NODE_A);
    expect(nodeBackoffRemainingMs(NODE_A)).toBe(BACKOFF_FIRST_MS);
    clock.advance(BACKOFF_FIRST_MS / 2);
    expect(nodeBackoffRemainingMs(NODE_A)).toBe(BACKOFF_FIRST_MS / 2);
    clock.advance(BACKOFF_FIRST_MS / 2);
    expect(nodeBackoffRemainingMs(NODE_A)).toBe(0);
  });
});

describe('unreachableBackoffKind', () => {
  test('TimeoutError 与 reason=timeout 走短退避', () => {
    const timedOut = new Error('timeout');
    timedOut.name = 'TimeoutError';
    expect(unreachableBackoffKind(timedOut)).toBe('timeout');
    expect(
      unreachableBackoffKind(
        new ApiError(503, 'x', { code: 'NODE_UNREACHABLE', reason: 'timeout' })
      )
    ).toBe('timeout');
  });

  test('no_link / 离线 / 未接纳走硬退避', () => {
    for (const reason of ['no_link', 'not_admitted', 'relay_reset:offline']) {
      expect(
        unreachableBackoffKind(new ApiError(503, 'x', { code: 'NODE_UNREACHABLE', reason }))
      ).toBe('hard');
    }
  });
});
