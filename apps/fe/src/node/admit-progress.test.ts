// 加入进度的状态投影：第二步的收场、结果行的收尾与关闭，以及与服务端真相的对账。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { WebAuthnError } from '@vibeterm/api-client/auth/index';
import {
  type AdmitFollowUp,
  type MemberKeyStep,
  abandonAdmit,
  admitErrorKey,
  awaitMemberKey,
  beginAdmit,
  dismissAdmitProgress,
  distributeMemberKey,
  markMemberKeysDelivered,
  reconcileMemberKeys,
  reportAdmitError,
  resendMemberKey,
  resetAdmitProgressForTest,
  withoutRowOwned,
} from './admit-progress';
import {
  type AdmitPhase,
  type AdmitProgress,
  getEnrollmentEngineState,
  resetEnrollmentEngineState,
  setEnrollmentEngineStateForTest,
} from './enrollment-engine-state';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from './mesh-relay';
import { PASSKEY_ABORTED } from './relay-enroll';

const NODE_A = 'aa'.repeat(16);
const NODE_B = 'bb'.repeat(16);

function seed(rows: Record<string, { phase: AdmitPhase; nodeId: string | null }>): void {
  const progressById = Object.fromEntries(
    Object.entries(rows).map(([id, row]) => [id, { ...row, steps: 2 as const, name: null }])
  );
  setEnrollmentEngineStateForTest({ progressById });
}

function phases(): Record<string, AdmitPhase> {
  return Object.fromEntries(
    Object.entries(getEnrollmentEngineState().progressById).map(([id, row]) => [id, row.phase])
  );
}

/** 一条第二步的桩：记下翻译过哪些 key（toast 用）与 `onDone` 的次数。 */
function stepOf(id: string, followUp: AdmitFollowUp) {
  const keys: string[] = [];
  const spy = { keys, done: 0, step: null as unknown as MemberKeyStep };
  spy.step = {
    id,
    followUp,
    t: (key: string) => {
      keys.push(key);
      return key;
    },
    onDone: () => {
      spy.done += 1;
    },
  };
  return spy;
}

/** 把一条加入推到「admit 已落账、等第二步」。 */
function reachSecondStep(id: string, nodeId: string | null): void {
  beginAdmit(id, null, true);
  awaitMemberKey(id, nodeId);
}

function progressOf(id: string): AdmitProgress | undefined {
  return getEnrollmentEngineState().progressById[id];
}

function count(keys: string[], key: string): number {
  return keys.filter((row) => row === key).length;
}

function lagging(...nodeIds: string[]) {
  return nodeIds.map((nodeId) => ({ nodeId, name: null, since: null, admitSeq: 1 }));
}

const PENDING_KEY = 'nodes.enrollment.memberKeyPending';
const ADMITTED_KEY = 'nodes.enrollment.admitted';

const warn = mock((..._args: unknown[]) => undefined);
const realWarn = console.warn;

beforeEach(() => {
  resetEnrollmentEngineState();
  resetAdmitProgressForTest();
  resetMeshRelayStateForTest();
  warn.mockClear();
  console.warn = warn;
});

afterEach(() => {
  console.warn = realWarn;
  resetMeshRelayStateForTest();
});

describe('一次确认的进度', () => {
  test('开始时进入第一步并清掉上一次的失败提示；没落账就撤掉', () => {
    setEnrollmentEngineStateForTest({ failureById: { 'e-1': 'nodes.enrollment.admitFailed' } });

    beginAdmit('e-1', 'alice-laptop', true);
    expect(getEnrollmentEngineState().failureById).toEqual({});
    expect(getEnrollmentEngineState().progressById['e-1']).toEqual({
      phase: 'admitting',
      steps: 2,
      name: 'alice-laptop',
      nodeId: null,
    });

    abandonAdmit('e-1');
    expect(getEnrollmentEngineState().progressById).toEqual({});
  });

  test('已经进入第二步的不会被当成没落账撤掉', () => {
    beginAdmit('e-1', null, true);
    awaitMemberKey('e-1', NODE_A);
    abandonAdmit('e-1');
    expect(getEnrollmentEngineState().progressById['e-1']).toMatchObject({
      phase: 'distributing',
      nodeId: NODE_A,
    });
  });
});

describe('admitErrorKey', () => {
  test('仪式被取消说取消，其余异常一律用成句的通用提示', () => {
    expect(admitErrorKey(new WebAuthnError('aborted', 'The operation was aborted'))).toBe(
      'auth.errors.PASSKEY_ABORTED'
    );
    expect(admitErrorKey(new Error('socket hang up'))).toBe('nodes.enrollment.admitFailed');
    expect(admitErrorKey(new WebAuthnError('failed', 'boom'))).toBe('nodes.enrollment.admitFailed');
  });
});

describe('reportAdmitError', () => {
  const t = (key: string) => key;

  test('超时 / 断网：行内给通用提示，原始异常留在控制台', () => {
    const err = new Error('socket hang up');
    reportAdmitError(t, 'e-1', err);
    expect(getEnrollmentEngineState().failureById).toEqual({
      'e-1': 'nodes.enrollment.admitFailed',
    });
    expect(warn).toHaveBeenCalledWith('[enroll] admit failed', err);
  });

  test('用户自己取消仪式不算故障：不往控制台记', () => {
    reportAdmitError(t, 'e-1', new WebAuthnError('aborted', 'passkey ceremony aborted'));
    expect(getEnrollmentEngineState().failureById).toEqual({
      'e-1': 'auth.errors.PASSKEY_ABORTED',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test('操作已作废（没有翻译函数）：只留痕，不往界面上写', () => {
    reportAdmitError(null, 'e-1', new Error('late'));
    expect(getEnrollmentEngineState().failureById).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('第二步的收场', () => {
  test('失败：停在待补发并带上错误码，告警一次', async () => {
    reachSecondStep('e-1', NODE_A);
    const spy = stepOf('e-1', async () => ({ ok: false, code: 'RELAY_OFFLINE' }));
    await distributeMemberKey(spy.step, true);

    expect(progressOf('e-1')).toMatchObject({ phase: 'keyPending', keyError: 'RELAY_OFFLINE' });
    expect(count(spy.keys, PENDING_KEY)).toBe(1);
    expect(spy.keys).not.toContain(ADMITTED_KEY);
    expect(spy.done).toBe(0);
  });

  test('第二次验证被用户取消：待补发，但不当作失败原因，也不往控制台记', async () => {
    reachSecondStep('code', NODE_A);
    reachSecondStep('thrown', NODE_B);
    const byCode = stepOf('code', async () => ({ ok: false, code: PASSKEY_ABORTED }));
    const byThrow = stepOf('thrown', () =>
      Promise.reject(new WebAuthnError('aborted', 'passkey ceremony aborted'))
    );
    await distributeMemberKey(byCode.step, true);
    await distributeMemberKey(byThrow.step, true);

    for (const id of ['code', 'thrown']) {
      expect(progressOf(id)?.phase).toBe('keyPending');
      expect(progressOf(id)?.keyError).toBeUndefined();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test('第二步抛异常：待补发 + 错误码，原始异常留在控制台', async () => {
    reachSecondStep('e-1', NODE_A);
    const err = new Error('socket hang up');
    const spy = stepOf('e-1', () => Promise.reject(err));
    await distributeMemberKey(spy.step, true);

    expect(progressOf('e-1')).toMatchObject({ phase: 'keyPending', keyError: 'socket hang up' });
    expect(warn).toHaveBeenCalledWith('[enroll] member key step failed', err);
  });

  test('不是用户手势发起、手上又不是根钥：第二步不跑，直接待补发', async () => {
    reachSecondStep('e-1', NODE_A);
    let calls = 0;
    const spy = stepOf('e-1', async () => {
      calls += 1;
      return { ok: true };
    });
    await distributeMemberKey(spy.step, false);

    expect(calls).toBe(0);
    expect(progressOf('e-1')?.phase).toBe('keyPending');
    expect(progressOf('e-1')?.keyError).toBeUndefined();
    expect(count(spy.keys, PENDING_KEY)).toBe(1);
  });

  test('补发：取消凭据框不告警；失败换成新原因；成功清掉原因并只报一次已加入', async () => {
    reachSecondStep('e-1', NODE_A);
    const results = [
      { ok: false as const, code: 'RELAY_OFFLINE' },
      { ok: false as const, code: 'relay_epoch_regression' },
      { ok: true as const },
    ];
    const seen: unknown[] = [];
    const spy = stepOf('e-1', async (nodeId, signer) => {
      seen.push({ nodeId, signer });
      return results.shift() ?? { ok: true };
    });
    await distributeMemberKey(spy.step, true);
    const signer = { kind: 'passkey', credentialId: 'cred-1' };
    let cancel = true;
    const prompt = {
      withSigner: (fn: (value: unknown) => unknown) =>
        cancel ? Promise.resolve(null) : Promise.resolve(fn(signer)),
    } as unknown as CredentialPromptHandle;

    await resendMemberKey(spy.step, prompt);
    // 取消：第二步没被调用，原因清掉（那已经是上一次的事），也不再告警。
    expect(seen).toHaveLength(1);
    expect(progressOf('e-1')?.phase).toBe('keyPending');
    expect(progressOf('e-1')?.keyError).toBeUndefined();
    expect(count(spy.keys, PENDING_KEY)).toBe(1);
    expect(warn).not.toHaveBeenCalled();

    cancel = false;
    await resendMemberKey(spy.step, prompt);
    expect(seen[1]).toEqual({ nodeId: NODE_A, signer });
    expect(progressOf('e-1')).toMatchObject({
      phase: 'keyPending',
      keyError: 'relay_epoch_regression',
    });
    expect(count(spy.keys, PENDING_KEY)).toBe(2);

    await resendMemberKey(spy.step, prompt);
    expect(progressOf('e-1')?.phase).toBe('done');
    expect(progressOf('e-1')?.keyError).toBeUndefined();
    expect(count(spy.keys, ADMITTED_KEY)).toBe(1);
    expect(spy.done).toBe(1);
  });
});

describe('reconcileMemberKeys：待补发与服务端真相对账', () => {
  async function hold(id: string, nodeId: string | null) {
    reachSecondStep(id, nodeId);
    const spy = stepOf(id, async () => ({ ok: false, code: 'RELAY_OFFLINE' }));
    await distributeMemberKey(spy.step, true);
    return spy;
  }

  test('节点不在欠账名单里了（重试回路 / 别的设备补上了）：收成已加入，只报一次', async () => {
    const spy = await hold('e-1', NODE_A);

    // 中继状态刷新、这台还欠着：不动。
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: lagging(NODE_A),
      requestedAt: Date.now() + 1_000,
    });
    expect(progressOf('e-1')?.phase).toBe('keyPending');

    setMeshRelayStateForTest({ metaKeyLagging: lagging(NODE_B), requestedAt: Date.now() + 2_000 });
    expect(progressOf('e-1')?.phase).toBe('done');
    expect(progressOf('e-1')?.keyError).toBeUndefined();
    expect(count(spy.keys, ADMITTED_KEY)).toBe(1);
    expect(spy.done).toBe(1);

    setMeshRelayStateForTest({ metaKeyLagging: [], requestedAt: Date.now() + 3_000 });
    expect(count(spy.keys, ADMITTED_KEY)).toBe(1);
    expect(spy.done).toBe(1);
  });

  test('在途的旧请求事后才落地也不作数：按请求发出的时刻判，不按响应落地的时刻', async () => {
    await hold('e-1', NODE_A);
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: [],
      requestedAt: Date.now() - 1_000,
      loadedAt: Date.now() + 1_000,
    });
    reconcileMemberKeys();
    expect(progressOf('e-1')?.phase).toBe('keyPending');
  });

  test('进入待补发之前拉到的状态不作数：那时新节点可能还不在成员表里', async () => {
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: [],
      requestedAt: Date.now() - 1_000,
    });
    await hold('e-1', NODE_A);
    reconcileMemberKeys();
    expect(progressOf('e-1')?.phase).toBe('keyPending');
  });

  test('解不出 node id、或本机已不走中继：不对账', async () => {
    await hold('unknown', null);
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: [],
      requestedAt: Date.now() + 1_000,
    });
    expect(progressOf('unknown')?.phase).toBe('keyPending');

    await hold('e-1', NODE_A);
    setMeshRelayStateForTest({ mode: 'none', metaKeyLagging: [], requestedAt: Date.now() + 2_000 });
    expect(progressOf('e-1')?.phase).toBe('keyPending');
  });

  test('正在补发的那条对账不抢先；取消凭据框后当场按已看到的状态收场', async () => {
    const spy = await hold('e-1', NODE_A);
    let release: (value: null) => void = () => undefined;
    const prompt = {
      withSigner: () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    } as unknown as CredentialPromptHandle;
    const resending = resendMemberKey(spy.step, prompt);
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: [],
      requestedAt: Date.now() + 1_000,
    });
    expect(progressOf('e-1')?.phase).toBe('distributing');
    expect(spy.keys).not.toContain(ADMITTED_KEY);

    release(null);
    await resending;
    expect(progressOf('e-1')?.phase).toBe('done');
    expect(count(spy.keys, ADMITTED_KEY)).toBe(1);
    expect(count(spy.keys, PENDING_KEY)).toBe(1);
  });

  test('用户关掉的结果行不再被对账', async () => {
    const spy = await hold('e-1', NODE_A);
    dismissAdmitProgress('e-1');
    setMeshRelayStateForTest({
      mode: 'relay',
      metaKeyLagging: [],
      requestedAt: Date.now() + 1_000,
    });
    expect(progressOf('e-1')).toBeUndefined();
    expect(spy.keys).not.toContain(ADMITTED_KEY);
  });
});

describe('withoutRowOwned', () => {
  const row = (phase: AdmitPhase, nodeId: string | null): AdmitProgress => ({
    phase,
    steps: 2,
    name: null,
    nodeId,
  });

  test('结果行正在下发 / 待补发的那几台不进告警条', () => {
    const rows = lagging(NODE_A, NODE_B);
    expect(withoutRowOwned(rows, [row('keyPending', NODE_A)])).toEqual(lagging(NODE_B));
    expect(withoutRowOwned(rows, [row('distributing', NODE_B), undefined])).toEqual(
      lagging(NODE_A)
    );
  });

  test('已收尾、解不出 node id 的行不占名额：告警条照常兜底', () => {
    const rows = lagging(NODE_A);
    expect(withoutRowOwned(rows, [row('done', NODE_A), row('expired', null)])).toBe(rows);
    expect(withoutRowOwned(rows, [row('keyPending', null)])).toBe(rows);
  });
});

describe('markMemberKeysDelivered', () => {
  test('只把补成的那几台收成已加入', () => {
    seed({
      a: { phase: 'keyPending', nodeId: NODE_A },
      b: { phase: 'keyPending', nodeId: NODE_B },
      running: { phase: 'distributing', nodeId: NODE_A },
    });
    markMemberKeysDelivered([NODE_A], false);
    expect(phases()).toEqual({ a: 'done', b: 'keyPending', running: 'distributing' });
  });

  test('解不出 node id 的那条只在整轮全部补成时才算数', () => {
    seed({ unknown: { phase: 'keyPending', nodeId: null } });
    markMemberKeysDelivered([NODE_A], false);
    expect(phases()).toEqual({ unknown: 'keyPending' });
    markMemberKeysDelivered([NODE_A], true);
    expect(phases()).toEqual({ unknown: 'done' });
  });
});

describe('dismissAdmitProgress', () => {
  test('结果可以关掉，进行中的不行', () => {
    seed({
      done: { phase: 'done', nodeId: NODE_A },
      pending: { phase: 'keyPending', nodeId: NODE_B },
      expired: { phase: 'expired', nodeId: null },
      running: { phase: 'distributing', nodeId: null },
    });
    for (const id of ['done', 'pending', 'expired', 'running']) dismissAdmitProgress(id);
    expect(phases()).toEqual({ running: 'distributing' });
  });
});
