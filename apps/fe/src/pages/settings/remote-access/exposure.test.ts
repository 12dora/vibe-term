// 暴露确认的归属与作废：勾选只对它自己那条警示旁边的动作生效，发出即作废，
// 保护状态或隧道运行态一变也作废；后端 409 之后的「勾选再重试」照常走得通。

import { describe, expect, test } from 'bun:test';
import type { TunnelActionRequest, TunnelStatusResponse } from '@tmex/shared';
import {
  EXPOSURE_ACK,
  type ExposureState,
  exposureAck,
  exposureAckIdOf,
  exposureShown,
  protectionSnapshot,
} from './exposure';

function status(overrides: Partial<TunnelStatusResponse> = {}): TunnelStatusResponse {
  return {
    supported: true,
    platform: 'darwin-arm64',
    binary: { installed: true, version: '2026.1.0', path: '/data/cloudflared', source: 'managed' },
    auth: { loggedIn: true, loginUrl: null },
    config: {
      mode: 'named',
      hostname: 'tmex.example.com',
      tunnelName: 'tmex',
      tunnelId: 'd8e1f0aa',
      autoStart: false,
      externallyManaged: false,
      originPort: 9883,
      accessMode: null,
    },
    process: {
      state: 'running',
      pid: 42,
      startedAt: '2026-08-30T00:00:00.000Z',
      publicUrl: 'https://tmex.example.com',
      lastError: null,
      restarts: 0,
    },
    connector: {
      reachable: null,
      metricsAddr: null,
      readyConnections: null,
      connectorId: null,
      checkedAt: null,
      lastError: null,
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
    loginEnforced: false,
    exposureProtected: false,
    job: null,
    trustProxy: false,
    configuredTrustProxy: false,
    restartRequired: false,
    log: [],
    ...overrides,
  };
}

/** 模拟标签层：勾选状态只有一份，但带着「属于哪条警示」的归属。 */
function tab(initial: string | null = null, overrides: Partial<ExposureState> = {}) {
  let ackedId = initial;
  const sent: TunnelActionRequest[] = [];
  return {
    sent,
    get ackedId() {
      return ackedId;
    },
    state: (): ExposureState => ({
      unprotected: true,
      ackRequired: false,
      ackRequiredId: null,
      ackedId,
      setAckedId: (id) => {
        ackedId = id;
      },
      ...overrides,
    }),
    run: (req: TunnelActionRequest) => {
      sent.push(req);
    },
  };
}

describe('exposureShown', () => {
  test('未受保护或后端要过确认时才出现，`drop` 档无条件出现', () => {
    const state = (over: Partial<ExposureState>): ExposureState => ({
      unprotected: false,
      ackRequired: false,
      ackRequiredId: null,
      ackedId: null,
      setAckedId: () => undefined,
      ...over,
    });
    expect(exposureShown(state({}), 'full')).toBe(false);
    expect(exposureShown(state({ unprotected: true }), 'compact')).toBe(true);
    expect(exposureShown(state({ ackRequired: true }), 'compact')).toBe(true);
    expect(exposureShown(state({}), 'drop')).toBe(true);
  });
});

describe('exposureAck', () => {
  test('只有自己那条警示被勾上才算确认', () => {
    const page = tab(EXPOSURE_ACK.start);
    expect(exposureAck(page.state(), EXPOSURE_ACK.start, true).checked).toBe(true);
    expect(exposureAck(page.state(), EXPOSURE_ACK.create, true).checked).toBe(false);
    // 警示没渲染出来（例如保护已恢复）时，残留的勾选一律不算数。
    expect(exposureAck(page.state(), EXPOSURE_ACK.start, false).checked).toBe(false);
  });

  test('勾选互斥：勾上一条会把别处的勾选顶掉', () => {
    const page = tab(EXPOSURE_ACK.start);
    exposureAck(page.state(), EXPOSURE_ACK.create, true).set(true);
    expect(page.ackedId).toBe(EXPOSURE_ACK.create);
    exposureAck(page.state(), EXPOSURE_ACK.create, true).set(false);
    expect(page.ackedId).toBeNull();
  });

  test('发出时带上确认，并立刻作废：同一个动作再点一次要重新勾', () => {
    const page = tab(EXPOSURE_ACK.quick);
    exposureAck(page.state(), EXPOSURE_ACK.quick, true).submit(page.run, { action: 'quick_start' });
    expect(page.sent).toEqual([{ action: 'quick_start', acknowledgeExposure: true }]);
    expect(page.ackedId).toBeNull();

    exposureAck(page.state(), EXPOSURE_ACK.quick, true).submit(page.run, { action: 'quick_start' });
    expect(page.sent[1]).toEqual({ action: 'quick_start' });
  });

  test('收敛动作不会被塞上确认', () => {
    const page = tab(EXPOSURE_ACK.accessMode);
    exposureAck(page.state(), EXPOSURE_ACK.accessMode, true).submit(page.run, {
      action: 'set_access_mode',
      accessMode: 'login',
    });
    expect(page.sent).toEqual([{ action: 'set_access_mode', accessMode: 'login' }]);
  });

  test('为启动隧道勾的确认，不会跟着「无」一起发出去', () => {
    const page = tab();
    // 用户在状态卡上勾了「启动」旁边那条警示。
    exposureAck(page.state(), EXPOSURE_ACK.start, true).set(true);
    expect(page.ackedId).toBe(EXPOSURE_ACK.start);

    // 隧道随后停了：标签层按保护指纹的变化把勾选作废。
    const before = protectionSnapshot(status());
    const after = protectionSnapshot(
      status({ process: { ...status().process, state: 'stopped' } })
    );
    expect(before).not.toBe(after);
    page.state().setAckedId(null);

    // 接着在访问控制步选「无」：请求里不能带确认，交给后端 409 挡下。
    const none = exposureAck(page.state(), EXPOSURE_ACK.accessMode, true);
    none.submit(page.run, { action: 'set_access_mode', accessMode: 'none' });
    expect(page.sent).toEqual([{ action: 'set_access_mode', accessMode: 'none' }]);
  });

  test('后端 409 之后：勾上这条警示再发一次就带上确认', () => {
    const page = tab(null, { unprotected: false, ackRequired: true });
    const first = exposureAck(
      page.state(),
      EXPOSURE_ACK.start,
      exposureShown(page.state(), 'compact')
    );
    // 保护看着还在，但后端已经要过确认：警示照样出现，且此刻还没勾。
    expect(first.shown).toBe(true);
    expect(first.checked).toBe(false);

    first.set(true);
    const retry = exposureAck(
      page.state(),
      EXPOSURE_ACK.start,
      exposureShown(page.state(), 'compact')
    );
    expect(retry.checked).toBe(true);
    retry.submit(page.run, { action: 'start' });
    expect(page.sent).toEqual([{ action: 'start', acknowledgeExposure: true }]);
    expect(page.ackedId).toBeNull();
  });
});

describe('exposureAckIdOf', () => {
  test('会开放公网的动作各自认领一条警示', () => {
    expect(exposureAckIdOf({ action: 'start' })).toBe(EXPOSURE_ACK.start);
    expect(exposureAckIdOf({ action: 'quick_start' })).toBe(EXPOSURE_ACK.quick);
    expect(exposureAckIdOf({ action: 'create', hostname: 'a.example.com' })).toBe(
      EXPOSURE_ACK.create
    );
    expect(exposureAckIdOf({ action: 'set_auto_start', autoStart: true })).toBe(
      EXPOSURE_ACK.autoStart
    );
    expect(exposureAckIdOf({ action: 'set_access_mode', accessMode: 'none' })).toBe(
      EXPOSURE_ACK.accessMode
    );
    expect(exposureAckIdOf({ action: 'set_access_enforce', enforceJwt: false })).toBe(
      EXPOSURE_ACK.accessEnforce
    );
    expect(exposureAckIdOf({ action: 'remove_access' })).toBe(EXPOSURE_ACK.accessRemove);
  });

  test('收敛动作与没有请求时都没有归属', () => {
    expect(exposureAckIdOf({ action: 'set_auto_start', autoStart: false })).toBeNull();
    expect(exposureAckIdOf({ action: 'set_access_mode', accessMode: 'login' })).toBeNull();
    expect(exposureAckIdOf({ action: 'set_access_enforce', enforceJwt: true })).toBeNull();
    expect(exposureAckIdOf({ action: 'stop' })).toBeNull();
    expect(exposureAckIdOf(null)).toBeNull();
  });
});

describe('409 兜底：被拒的那个动作一定拿得到勾选框', () => {
  const ACCESS_MODE: string = EXPOSURE_ACK.accessMode;
  const ACCESS_REMOVE: string = EXPOSURE_ACK.accessRemove;

  /** 后端判定暴露的口径比前端宽，本地判定说「不用确认」时照样会吃 409。 */
  const rejected = (id: string): ExposureState => ({
    unprotected: false,
    ackRequired: true,
    ackRequiredId: id,
    ackedId: null,
    setAckedId: () => undefined,
  });

  test('本地判定说不必确认，仍然渲染被拒动作那一条', () => {
    const state = rejected(EXPOSURE_ACK.accessMode);
    const ack = exposureAck(state, EXPOSURE_ACK.accessMode, false);
    expect(ack.shown).toBe(true);
    expect(ack.ackRequired).toBe(true);
    expect(ack.checked).toBe(false);
  });

  test('只作用于被拒的那个动作，别的动作不受影响', () => {
    const state = rejected(EXPOSURE_ACK.accessRemove);
    expect(exposureAck(state, EXPOSURE_ACK.accessEnforce, false).shown).toBe(false);
    expect(exposureAck(state, EXPOSURE_ACK.accessEnforce, false).ackRequired).toBe(false);
    expect(exposureAck(state, EXPOSURE_ACK.start, false).shown).toBe(false);
  });

  test('`exposureShown` 传入 id 时同样认这条兜底', () => {
    const state = rejected(EXPOSURE_ACK.accessRemove);
    expect(exposureShown(state, 'compact', EXPOSURE_ACK.accessRemove)).toBe(true);
    // 没有 409 归属时按原来的判定走：受保护 + 没有全局 ackRequired 就不出现。
    const quiet: ExposureState = { ...state, ackRequired: false, ackRequiredId: null };
    expect(exposureShown(quiet, 'compact', EXPOSURE_ACK.accessRemove)).toBe(false);
  });

  test('勾上之后重试就带上确认', () => {
    const page = tab(null, { unprotected: false, ackRequired: true, ackRequiredId: ACCESS_MODE });

    exposureAck(page.state(), ACCESS_MODE, false).set(true);
    expect(page.ackedId).toBe(ACCESS_MODE);

    const retry = exposureAck(page.state(), ACCESS_MODE, false);
    expect(retry.checked).toBe(true);
    retry.submit(page.run, { action: 'set_access_mode', accessMode: 'none' });
    expect(page.sent).toEqual([
      { action: 'set_access_mode', accessMode: 'none', acknowledgeExposure: true },
    ]);
    expect(page.ackedId).toBeNull();
  });

  test('移除 Access 被拒后同样勾得上、带得走', () => {
    const page = tab(null, {
      unprotected: false,
      ackRequired: true,
      ackRequiredId: ACCESS_REMOVE,
    });

    const ack = exposureAck(page.state(), ACCESS_REMOVE, false);
    expect(ack.shown).toBe(true);
    ack.set(true);
    exposureAck(page.state(), ACCESS_REMOVE, false).submit(page.run, { action: 'remove_access' });
    expect(page.sent).toEqual([{ action: 'remove_access', acknowledgeExposure: true }]);
  });
});

describe('protectionSnapshot', () => {
  test('保护状态与隧道运行态任一变化都会换指纹', () => {
    const base = status();
    expect(protectionSnapshot(base)).toBe(protectionSnapshot(status()));
    expect(protectionSnapshot(status({ exposureProtected: true }))).not.toBe(
      protectionSnapshot(base)
    );
    expect(protectionSnapshot(status({ process: { ...base.process, state: 'stopped' } }))).not.toBe(
      protectionSnapshot(base)
    );
  });
});
