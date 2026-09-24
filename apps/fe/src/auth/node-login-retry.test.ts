// 每 node 的登录失败记账与网络类失败的自动退避重试。
// 定时器全部注入，不等真实时间；随机数固定，断言的是阶梯本身。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  LOGIN_RETRY_FIRST_MAX_MS,
  LOGIN_RETRY_FIRST_MS,
  LOGIN_RETRY_MAX_ATTEMPTS,
  LOGIN_RETRY_MAX_MS,
  type LoginRetryTimers,
  clearAllNodeLoginRetries,
  getNodeLoginFailure,
  loginRetryDelayMs,
  noteNodeLoginFailure,
  noteNodeLoginSuccess,
  retryNodeLoginNow,
  setNodeLoginRetryTimersForTest,
  subscribeNodeLoginFailures,
} from './node-login-retry';

const NODE = 'n1';

interface FakeTimers extends LoginRetryTimers {
  /** 排着的重试：`[延迟, 触发]`。 */
  pending: Array<{ ms: number; fire: () => void }>;
  cancelled: number;
}

function fakeTimers(random = 0): FakeTimers {
  const pending: FakeTimers['pending'] = [];
  const timers: FakeTimers = {
    pending,
    cancelled: 0,
    schedule(fn, ms) {
      // 真实 setTimeout 触发一次就没了：假的也必须先把自己摘掉再执行。
      const handle = {
        ms,
        fire: () => {
          const at = pending.indexOf(handle);
          if (at >= 0) pending.splice(at, 1);
          fn();
        },
      };
      pending.push(handle);
      return handle;
    },
    cancel(handle) {
      const index = pending.indexOf(handle as FakeTimers['pending'][number]);
      if (index >= 0) pending.splice(index, 1);
      timers.cancelled += 1;
    },
    random: () => random,
  };
  return timers;
}

let timers: FakeTimers;

beforeEach(() => {
  timers = fakeTimers();
  setNodeLoginRetryTimersForTest(timers);
});

afterEach(() => setNodeLoginRetryTimersForTest(null));

describe('loginRetryDelayMs', () => {
  test('首次落在 3–6 秒的抖动窗口里', () => {
    expect(loginRetryDelayMs(1, () => 0)).toBe(LOGIN_RETRY_FIRST_MS);
    expect(loginRetryDelayMs(1, () => 0.999999)).toBe(LOGIN_RETRY_FIRST_MAX_MS);
  });

  test('逐次翻倍并封顶，绝不无限缩短也绝不无限拉长', () => {
    const zero = () => 0;
    expect(loginRetryDelayMs(2, zero)).toBe(LOGIN_RETRY_FIRST_MS * 2);
    expect(loginRetryDelayMs(3, zero)).toBe(LOGIN_RETRY_FIRST_MS * 4);
    expect(loginRetryDelayMs(20, zero)).toBe(LOGIN_RETRY_MAX_MS);
  });
});

describe('noteNodeLoginFailure', () => {
  test('网络类失败：记成 unreachable 并排一次退避重试', () => {
    const record = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(record).toEqual({
      code: 'NODE_UNREACHABLE',
      kind: 'unreachable',
      attempts: 1,
      retrying: true,
    });
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0].ms).toBe(LOGIN_RETRY_FIRST_MS);
  });

  test('到点只抹记录：门闸据此在下一帧自己重发，这里不发任何请求', () => {
    noteNodeLoginFailure(NODE, 'NETWORK_ERROR');
    timers.pending[0].fire();
    expect(getNodeLoginFailure(NODE)).toBeNull();
    expect(timers.pending).toHaveLength(0);
  });

  test('阶梯跨过「抹记录」保留：第二次失败等得更久，不会永远停在第一级', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    timers.pending[0].fire();
    const second = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(second.attempts).toBe(2);
    expect(timers.pending[0].ms).toBe(LOGIN_RETRY_FIRST_MS * 2);
  });

  test('重试有上限：用完就停在错误态，不留常驻定时器', () => {
    for (let i = 0; i < LOGIN_RETRY_MAX_ATTEMPTS; i += 1) {
      const record = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
      expect(record.retrying).toBe(true);
      timers.pending[0].fire();
    }
    const last = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(last.attempts).toBe(LOGIN_RETRY_MAX_ATTEMPTS + 1);
    expect(last.retrying).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  test('凭证类失败不重试：同一份会话钥再发多少次都是同一个结论', () => {
    const record = noteNodeLoginFailure(NODE, 'NO_SESSION_KEY');
    expect(record).toEqual({
      code: 'NO_SESSION_KEY',
      kind: 'credential',
      attempts: 0,
      retrying: false,
    });
    expect(timers.pending).toHaveLength(0);
  });

  test('其它结论（限流等）同样不重试', () => {
    expect(noteNodeLoginFailure(NODE, 'RATE_LIMITED').retrying).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });

  test('凭证类失败会把网络类的阶梯清掉：链路显然是通的', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    noteNodeLoginFailure(NODE, 'NO_SESSION_KEY');
    expect(timers.pending).toHaveLength(0);
    const again = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(again.attempts).toBe(1);
  });

  test('每 node 各记各的', () => {
    noteNodeLoginFailure('a', 'NODE_UNREACHABLE');
    noteNodeLoginFailure('b', 'NO_SESSION_KEY');
    expect(getNodeLoginFailure('a')?.kind).toBe('unreachable');
    expect(getNodeLoginFailure('b')?.kind).toBe('credential');
  });
});

describe('清账', () => {
  test('登录成功：记录、阶梯与在途定时器一起清掉', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    noteNodeLoginSuccess(NODE);
    expect(getNodeLoginFailure(NODE)).toBeNull();
    expect(timers.pending).toHaveLength(0);
    expect(noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE').attempts).toBe(1);
  });

  test('用户主动重试：阶梯归零，下一次失败重新从第一级起步', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    retryNodeLoginNow(NODE);
    expect(getNodeLoginFailure(NODE)).toBeNull();
    expect(noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE').attempts).toBe(1);
  });

  test('页面重新可见 / 网络恢复：网络类立即作废，凭证类留着（它跟链路无关）', () => {
    noteNodeLoginFailure('a', 'NETWORK_ERROR');
    noteNodeLoginFailure('b', 'NO_SESSION_KEY');
    clearAllNodeLoginRetries();
    expect(getNodeLoginFailure('a')).toBeNull();
    expect(getNodeLoginFailure('b')?.code).toBe('NO_SESSION_KEY');
    expect(timers.pending).toHaveLength(0);
    expect(noteNodeLoginFailure('a', 'NETWORK_ERROR').attempts).toBe(1);
  });

  test('NODE_UNREACHABLE：恢复信号只换一次立即重试，阶梯保留，不会重来一轮 8 连发', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    clearAllNodeLoginRetries();
    expect(getNodeLoginFailure(NODE)).toBeNull();
    expect(timers.pending).toHaveLength(0);
    const next = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(next.attempts).toBe(3);
    expect(timers.pending[0].ms).toBe(LOGIN_RETRY_FIRST_MS * 4);
  });

  test('NODE_UNREACHABLE 阶梯用完后：每次恢复只多一次探测，之后不再排定时器', () => {
    for (let i = 0; i <= LOGIN_RETRY_MAX_ATTEMPTS; i += 1) {
      noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
      timers.pending[0]?.fire();
    }
    expect(getNodeLoginFailure(NODE)?.retrying).toBe(false);
    clearAllNodeLoginRetries();
    expect(getNodeLoginFailure(NODE)).toBeNull();
    const probe = noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(probe.retrying).toBe(false);
    expect(timers.pending).toHaveLength(0);
  });
});

describe('订阅', () => {
  test('记一次失败、抹一次失败各通知一轮', () => {
    let hits = 0;
    const off = subscribeNodeLoginFailures(() => {
      hits += 1;
    });
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(hits).toBe(1);
    timers.pending[0].fire();
    expect(hits).toBe(2);
    off();
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(hits).toBe(2);
  });

  test('同一份记录对象保持稳定引用：useSyncExternalStore 不会因此空转', () => {
    noteNodeLoginFailure(NODE, 'NODE_UNREACHABLE');
    expect(getNodeLoginFailure(NODE)).toBe(getNodeLoginFailure(NODE));
  });
});
