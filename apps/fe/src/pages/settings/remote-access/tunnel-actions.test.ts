// 动作串行化：一把锁挡住并发、job 在跑时只放行 cancel_login、check 结果与失败后的重拉。

import { describe, expect, test } from 'bun:test';
import { TunnelApiError } from '@tmex/api-client/local/tunnel-api';
import type {
  TunnelActionRequest,
  TunnelActionResponse,
  TunnelJobStatus,
  TunnelStatusResponse,
} from '@tmex/shared';
import {
  TunnelActionController,
  checkResultOf,
  checkRunning,
  isTunnelBusy,
} from './tunnel-actions';

function noop(): void {}

function status(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
  return {
    supported: true,
    platform: 'linux-x64',
    binary: { installed: true, version: '2026.1.0', path: '/data/cloudflared', source: 'managed' },
    auth: { loggedIn: false, loginUrl: null },
    config: {
      mode: 'off',
      hostname: null,
      tunnelName: null,
      tunnelId: null,
      autoStart: false,
      externallyManaged: false,
      originPort: 9883,
    },
    process: {
      state: 'stopped',
      pid: null,
      startedAt: null,
      publicUrl: null,
      lastError: null,
      restarts: 0,
    },
    access: {
      hasCredentials: false,
      accountId: null,
      teamDomain: null,
      configured: false,
      appId: null,
      aud: null,
      hostname: null,
      rules: [],
      enforceJwt: true,
      effective: false,
      bypassAppId: null,
      lastError: null,
    },
    external: {
      detected: false,
      source: null,
      configPath: null,
      tunnelId: null,
      tunnelName: null,
      hostnames: [],
      hasOriginCert: false,
      running: false,
    },
    loginEnforced: true,
    exposureProtected: true,
    job: null,
    trustProxy: false,
    configuredTrustProxy: false,
    restartRequired: false,
    log: [],
    ...overrides,
  };
}

function job(overrides: Partial<TunnelJobStatus> = {}): TunnelJobStatus {
  return {
    id: 'j1',
    kind: 'check',
    state: 'done',
    step: null,
    error: null,
    startedAt: '2026-08-30T00:00:00.000Z',
    finishedAt: '2026-08-30T00:00:01.000Z',
    ...overrides,
  };
}

interface Harness {
  controller: TunnelActionController;
  calls: TunnelActionRequest[];
  statuses: TunnelStatusResponse[];
  refreshes: number;
  setStatus: (next: TunnelStatusResponse) => void;
}

function harness(
  run: (body: TunnelActionRequest) => Promise<TunnelActionResponse>,
  initial: TunnelStatusResponse = status()
): Harness {
  let current = initial;
  const h: Harness = {
    calls: [],
    statuses: [],
    refreshes: 0,
    setStatus: (next) => {
      current = next;
    },
    controller: null as unknown as TunnelActionController,
  };
  h.controller = new TunnelActionController(
    (body) => {
      h.calls.push(body);
      return run(body);
    },
    () => current,
    () => ({
      onStatus: (next) => {
        h.statuses.push(next);
        current = next;
      },
      onRefresh: () => {
        h.refreshes += 1;
      },
    })
  );
  return h;
}

describe('isTunnelBusy', () => {
  test('有挂起动作或后台 job 在跑都算忙', () => {
    expect(isTunnelBusy(null, status())).toBe(false);
    expect(isTunnelBusy('install', status())).toBe(true);
    expect(isTunnelBusy(null, status({ job: job({ kind: 'install', state: 'running' }) }))).toBe(
      true
    );
    expect(isTunnelBusy(null, status({ job: job({ kind: 'install', state: 'done' }) }))).toBe(
      false
    );
  });
});

describe('TunnelActionController 锁', () => {
  test('挂起期间第二次调用直接丢弃', async () => {
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => {
      await gate;
      return { status: status(), job: null };
    });

    const first = h.controller.run({ action: 'install' });
    expect(h.controller.snapshot().pending).toBe('install');
    await h.controller.run({ action: 'quick_start' });
    expect(h.calls).toHaveLength(1);

    release();
    await first;
    expect(h.controller.snapshot().pending).toBeNull();
  });

  test('后台 job 在跑时挡下普通动作，但放行 cancel_login', async () => {
    const running = status({ job: job({ kind: 'login', state: 'running', step: null }) });
    const h = harness(async () => ({ status: status(), job: null }), running);

    await h.controller.run({ action: 'install' });
    expect(h.calls).toHaveLength(0);

    await h.controller.run({ action: 'cancel_login' });
    expect(h.calls).toEqual([{ action: 'cancel_login' }]);
  });
});

describe('TunnelActionController 结果处理', () => {
  test('成功时把响应里的新快照写回', async () => {
    const next = status({ config: { ...status().config, mode: 'quick' } });
    const h = harness(async () => ({ status: next, job: null }));
    await h.controller.run({ action: 'quick_start' });
    expect(h.statuses).toEqual([next]);
    expect(h.controller.snapshot().error).toBeNull();
  });

  test('check 只记下 job id，结论要等轮询：running → done', async () => {
    const accepted = job({ id: 'check-1', state: 'running', finishedAt: null });
    const h = harness(async () => ({ status: status({ job: accepted }), job: accepted }));
    await h.controller.run({ action: 'check' });

    expect(h.controller.snapshot().checkJobId).toBe('check-1');
    // 受理时的 202 什么都不说明，此刻不能有结论。
    expect(checkResultOf(accepted, 'check-1')).toBeNull();

    const done = job({ id: 'check-1', state: 'done' });
    expect(checkResultOf(done, 'check-1')).toEqual({ ok: true, message: null });
  });

  test('check 的 job 转 error 时给不可达与服务端 message：running → error', async () => {
    const accepted = job({ id: 'check-2', state: 'running', finishedAt: null });
    const h = harness(async () => ({ status: status({ job: accepted }), job: accepted }));
    await h.controller.run({ action: 'check' });

    const failed = job({
      id: 'check-2',
      state: 'error',
      error: { code: 'unknown', message: 'health check HTTP 502' },
    });
    expect(checkResultOf(failed, h.controller.snapshot().checkJobId)).toEqual({
      ok: false,
      message: 'health check HTTP 502',
    });
  });

  test('再次点击检查会先清掉上一次的 job id', async () => {
    let id = 'check-a';
    const h = harness(async () => {
      const accepted = job({ id, state: 'running', finishedAt: null });
      return { status: status({ job: accepted }), job: accepted };
    });
    await h.controller.run({ action: 'check' });
    expect(h.controller.snapshot().checkJobId).toBe('check-a');
    // 上一个 job 结束后才轮得到第二次检查（job 在跑时动作会被锁挡住）。
    h.setStatus(status({ job: job({ id: 'check-a', state: 'done' }) }));
    id = 'check-b';
    await h.controller.run({ action: 'check' });
    expect(h.controller.snapshot().checkJobId).toBe('check-b');
  });

  test('失败时保留错误码并重拉状态', async () => {
    const h = harness(async () => {
      throw new TunnelApiError('busy', 'another action is running', 409);
    });
    await h.controller.run({ action: 'start' });
    expect(h.controller.snapshot().error).toEqual({
      code: 'busy',
      message: 'another action is running',
    });
    expect(h.refreshes).toBe(1);
    expect(h.controller.snapshot().pending).toBeNull();
  });

  test('新动作开始时清掉上一次的错误', async () => {
    let fail = true;
    const h = harness(async () => {
      if (fail) throw new TunnelApiError('download_failed', 'timeout', 500);
      return { status: status(), job: null };
    });
    await h.controller.run({ action: 'install' });
    expect(h.controller.snapshot().error?.code).toBe('download_failed');
    fail = false;
    await h.controller.run({ action: 'install' });
    expect(h.controller.snapshot().error).toBeNull();
  });
});

describe('checkRunning', () => {
  test('只在轮询到的就是这次受理的 job 且仍在跑时为真', () => {
    expect(checkRunning(job({ id: 'check-1', state: 'running' }), 'check-1')).toBe(true);
    expect(checkRunning(job({ id: 'check-1', state: 'done' }), 'check-1')).toBe(false);
    expect(checkRunning(null, 'check-1')).toBe(false);
    expect(checkRunning(job({ id: 'check-1', state: 'running' }), null)).toBe(false);
  });

  test('被别的动作的 job 顶掉后不再算「正在检查」，也不给结论', () => {
    const other = job({ id: 'start-1', kind: 'start', state: 'running' });
    expect(checkRunning(other, 'check-1')).toBe(false);
    expect(checkResultOf(other, 'check-1')).toBeNull();
  });
});

describe('checkResultOf', () => {
  test('没有 job、job 对不上号或还在跑，一律没有结论', () => {
    expect(checkResultOf(null, 'check-1')).toBeNull();
    expect(checkResultOf(job({ id: 'other', state: 'done' }), 'check-1')).toBeNull();
    expect(checkResultOf(job({ id: 'check-1', state: 'running' }), 'check-1')).toBeNull();
    expect(checkResultOf(job({ id: 'check-1', state: 'done' }), null)).toBeNull();
  });

  test('job 报错但没有 message 时退回错误码', () => {
    expect(
      checkResultOf(
        job({ id: 'check-1', state: 'error', error: { code: 'process_failed', message: '' } }),
        'check-1'
      )
    ).toEqual({ ok: false, message: 'process_failed' });
  });
});
