// 宿主级 enrollment 引擎：一条监听回路 + 一条 admit 流水线。
//
// 核心不变量：无论挂了几个消费方（设置页 + 侧滑面板），同一张证书都只能签出**一条**
// `admit-node`；且任意两条 admit 的 `keyLogHead → 签名 → append` 之间不许交叠——
// 交叠就是同一个 head 上的两个 seq，hub 只收得下一条，另一条永久 `seq_gap`。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const {
  createEnrollment,
  createNodeCertificate,
  decodeBase64url,
  decodeKeyLogRecord,
  encodeBase64url,
  generateEd25519KeyPair,
  rootKeyFromSeed,
} = await import('@tmex/shared/auth');
const { forgetSigner, rememberSigner } = await import('@/auth/credential-prompt');
const {
  addPendingEnrollment,
  clearPendingEnrollments,
  clearUnconfirmedRecords,
  listPendingEnrollments,
  listUnconfirmedRecordIds,
  setPendingStorage,
  submitAdmitRecord,
  unconfirmedRecord,
} = await import('./enrollment');
const {
  cancelPending,
  configureEnrollmentEngineForTest,
  enrollmentEngineDebugForTest,
  getEnrollmentEngineState,
  registerAdmitContext,
  resetEnrollmentEngineForTest,
} = await import('./enrollment-engine');
const { offerCertificate } = await import('./enrollment-watch');

type AdmitContext = Parameters<typeof registerAdmitContext>[0];
type PendingEnrollment = ReturnType<typeof listPendingEnrollments>[number];
type CertificateCandidate = Parameters<typeof offerCertificate>[1];

const UID = 'user-1';
const NOW = 1_700_000_000_000;
const rootKey = rootKeyFromSeed(new Uint8Array(32).fill(0x42));

async function fixture(id: string): Promise<{
  pending: PendingEnrollment;
  candidate: CertificateCandidate;
}> {
  const enrollment = await createEnrollment(rootKey, { uid: UID, rootEpoch: 1, now: NOW });
  const pending: PendingEnrollment = {
    hubEnrollmentId: id,
    enrollPk: encodeBase64url(enrollment.enrollPk),
    authorizationBytes: encodeBase64url(enrollment.authorizationBytes),
    authorizationSig: encodeBase64url(enrollment.authorizationSig),
    exp: NOW + 600_000,
    name: null,
    createdAt: NOW,
  };
  const ed = generateEd25519KeyPair();
  const x = generateEd25519KeyPair();
  const cert = createNodeCertificate(enrollment.enrollSk, {
    uid: UID,
    edPk: ed.publicKey,
    x25519Pk: x.publicKey,
    enrollPk: enrollment.enrollPk,
    now: NOW,
  });
  return {
    pending,
    candidate: {
      certificate: encodeBase64url(cert.certificateBytes),
      certSig: encodeBase64url(cert.certSig),
    },
  };
}

interface ApiSpy {
  api: AuthApi;
  appended: { bytes: string; sig: string }[];
}

function apiSpy(result: { ok: true; hubAck: true } | { ok: false; code: string }): ApiSpy {
  const appended: { bytes: string; sig: string }[] = [];
  return {
    appended,
    api: {
      keyLogHead: () =>
        Promise.resolve({ seq: 5, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
      appendKeyLog: (body: { bytes: string; sig: string }) => {
        appended.push(body);
        return Promise.resolve(result);
      },
    } as unknown as AuthApi,
  };
}

interface PromptSpy {
  prompt: AdmitContext['prompt'];
  requests: number;
}

function promptSpy(signer: unknown = null): PromptSpy {
  const spy: PromptSpy = {
    requests: 0,
    prompt: {
      request: () => {
        spy.requests += 1;
        return Promise.resolve(signer);
      },
      withSigner: () => Promise.resolve(null),
      forget: () => undefined,
      dialog: null,
      passkeys: [],
    } as unknown as AdmitContext['prompt'],
  };
  return spy;
}

function context(api: AuthApi, prompt = promptSpy().prompt): AdmitContext {
  return {
    api,
    mode: { uid: UID, rootEpoch: 1 },
    hubApi: null,
    prompt,
    onDone: () => undefined,
    t: (key: string) => key,
  };
}

function recordSeq(record: { bytes: string }): bigint {
  return decodeKeyLogRecord(decodeBase64url(record.bytes)).seq;
}

// 推送源桩：`push()` 直接喂给引擎注册的监听器。
const pushHandlers = new Set<(event: { certificate: string; certSig: string }) => void>();
let starts = 0;
const events = {
  start: () => {
    starts += 1;
  },
  onEnrollRedeemed: (handler: (event: { certificate: string; certSig: string }) => void) => {
    pushHandlers.add(handler);
    return () => pushHandlers.delete(handler);
  },
} as unknown as Parameters<typeof configureEnrollmentEngineForTest>[0]['events'];

function push(candidate: CertificateCandidate): void {
  for (const handler of [...pushHandlers]) handler(candidate);
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 多轮宏任务：一条 admit 里串着取 head、签名、append 好几段异步。 */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await flush();
}

let collectCalls = 0;
let collectResult: CertificateCandidate[] = [];
/** 轮询请求的往返延迟（宏任务轮数）：用来制造「结果回来时局面已经变了」的时序。 */
let collectDelay = 0;

beforeEach(() => {
  resetEnrollmentEngineForTest();
  pushHandlers.clear();
  starts = 0;
  collectCalls = 0;
  collectResult = [];
  collectDelay = 0;
  forgetSigner();
  setPendingStorage({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  clearPendingEnrollments();
  clearUnconfirmedRecords();
  configureEnrollmentEngineForTest({
    events,
    now: () => NOW,
    intervalMs: 3_600_000,
    collect: async () => {
      collectCalls += 1;
      for (let i = 0; i < collectDelay; i += 1) await flush();
      return collectResult;
    },
  });
});

describe('单例回路', () => {
  test('两个消费方只跑一条回路，一个 outcome 只签一条 admit（最后注册的上下文生效）', async () => {
    const { pending, candidate } = await fixture('e-1');
    collectResult = [candidate];
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const first = apiSpy({ ok: true, hubAck: true });
    const second = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const one = registerAdmitContext(context(first.api));
    const two = registerAdmitContext(context(second.api));
    // 推送订阅与轮询各一份：第二个消费方没有再开一条。
    expect(starts).toBe(1);
    expect(pushHandlers.size).toBe(1);
    await settle();
    expect(collectCalls).toBe(1);
    // 证书只被签了一次，且交给最后注册的上下文。
    expect(first.appended).toHaveLength(0);
    expect(second.appended).toHaveLength(1);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-1']);
    expect(listPendingEnrollments()).toHaveLength(0);

    two.release();
    one.release();
  });

  test('同一张证书连续到达两次也只签一次（模块级 in-flight 锁）', async () => {
    const { pending, candidate } = await fixture('e-2');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api));
    push(candidate);
    push(candidate);
    await settle();

    expect(spy.appended).toHaveLength(1);
    ctx.release();
  });

  test('注销后回落到上一个上下文，全部注销则停掉回路', async () => {
    const one = await fixture('e-3');
    const two = await fixture('e-4');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const first = apiSpy({ ok: true, hubAck: true });
    const second = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(one.pending);
    const page = registerAdmitContext(context(first.api));
    const panel = registerAdmitContext(context(second.api));
    push(one.candidate);
    await settle();
    expect(second.appended).toHaveLength(1);

    // 后注册的走了：回落到第一个上下文，回路继续跑。
    panel.release();
    expect(enrollmentEngineDebugForTest().contexts).toBe(1);
    addPendingEnrollment(two.pending);
    rememberSigner({ kind: 'root', rootKey }, NOW);
    push(two.candidate);
    await settle();
    expect(first.appended).toHaveLength(1);
    expect(second.appended).toHaveLength(1);

    // 没有消费方了：推送订阅与轮询都撤掉。
    page.release();
    expect(enrollmentEngineDebugForTest()).toMatchObject({ contexts: 0, watching: false });
    expect(pushHandlers.size).toBe(0);
  });

  test('生效上下文没有 hub 通道时，轮询回落到最近一个有 hub 通道的上下文', async () => {
    const { pending, candidate } = await fixture('e-12');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });
    const hubApi = {
      getEnrollment: () =>
        Promise.resolve({
          status: 'redeemed',
          enroll_pk: pending.enrollPk,
          certificate: candidate.certificate,
          cert_sig: candidate.certSig,
        }),
    } as unknown as AdmitContext['hubApi'];
    // 真实轮询路径：不注入 collect。
    configureEnrollmentEngineForTest({ collect: undefined });

    addPendingEnrollment(pending);
    // 先注册带 hub 通道的设置页，再注册还没定位到 hub 的面板。
    const page = registerAdmitContext({ ...context(spy.api), hubApi });
    const panel = registerAdmitContext(context(spy.api));
    await settle();

    expect(spy.appended).toHaveLength(1);
    panel.release();
    page.release();
  });

  test('passkey 用户不自动签，只把 pending 标成「证书已到」等手动确认', async () => {
    const { pending, candidate } = await fixture('e-5');
    rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api));
    push(candidate);
    await settle();

    expect(spy.appended).toHaveLength(0);
    expect(getEnrollmentEngineState().certificateReadyIds).toEqual(['e-5']);
    expect(listPendingEnrollments()).toHaveLength(1);
    ctx.release();
  });

  test('证书对不上 pending 时按 id 记下提示 key', async () => {
    const { pending, candidate } = await fixture('e-6');
    const spy = apiSpy({ ok: true, hubAck: true });
    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api));
    // 换一份坏签名：`bad_cert_sig`
    push({ certificate: candidate.certificate, certSig: encodeBase64url(new Uint8Array(64)) });
    await settle();

    expect(getEnrollmentEngineState().invalidById['e-6']).toBe('nodes.enrollment.badCertSig');
    ctx.release();
  });

  test('admit 成功后每个活着的消费方都会被刷新，而不只是签名的那个', async () => {
    const { pending, candidate } = await fixture('e-13');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });
    const done: string[] = [];

    addPendingEnrollment(pending);
    const page = registerAdmitContext({
      ...context(spy.api),
      onDone: () => done.push('page'),
    });
    const panel = registerAdmitContext({
      ...context(spy.api),
      onDone: () => done.push('panel'),
    });
    push(candidate);
    await settle();

    expect(done.sort()).toEqual(['page', 'panel']);
    panel.release();
    page.release();
  });

  test('槽位 mode 还是 null 的消费方不会挡住可签名的那个', async () => {
    const { pending, candidate } = await fixture('e-14');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const page = registerAdmitContext(context(spy.api));
    // 面板先于 `/api/auth/mode` 返回就注册进来：它签不了，但不该让整条流水线停摆。
    const panel = registerAdmitContext({ ...context(spy.api), mode: null });
    push(candidate);
    await settle();

    expect(spy.appended).toHaveLength(1);
    panel.release();
    page.release();
  });
});

describe('全局 key log 写锁', () => {
  test('两条不同 pending 的 admit 串行：第二条签在第一条 append 之后的头上', async () => {
    const one = await fixture('e-lock-1');
    const two = await fixture('e-lock-2');
    rememberSigner({ kind: 'root', rootKey }, NOW);

    const order: string[] = [];
    const appended: { bytes: string; sig: string }[] = [];
    const api = {
      // head 随已 append 的条数推进；取 head 本身是异步的（真实实现要过网络）。
      keyLogHead: async () => {
        order.push('head');
        await flush();
        return {
          seq: 5 + appended.length,
          hash: encodeBase64url(new Uint8Array(32).fill(7)),
        };
      },
      appendKeyLog: (body: { bytes: string; sig: string }) => {
        order.push('append');
        appended.push(body);
        return Promise.resolve({ ok: true as const, hubAck: true });
      },
    } as unknown as AuthApi;

    addPendingEnrollment(one.pending);
    addPendingEnrollment(two.pending);
    const ctx = registerAdmitContext(context(api));
    // 两张证书几乎同时到达：取 head 的 promise 必然交叠。
    push(one.candidate);
    push(two.candidate);
    await settle(12);

    expect(order).toEqual(['head', 'append', 'head', 'append']);
    expect(appended).toHaveLength(2);
    expect(recordSeq(appended[0])).toBe(6n);
    // 第二条看到的是第一条 append 之后的头，而不是同一个。
    expect(recordSeq(appended[1])).toBe(7n);
    expect(getEnrollmentEngineState().admittedIds.sort()).toEqual(['e-lock-1', 'e-lock-2']);
    ctx.release();
  });
});

describe('陈旧结果复核', () => {
  test('推送已 admit 之后，轮询带回的同一张证书被静默丢弃', async () => {
    const { pending, candidate } = await fixture('e-stale');
    collectResult = [candidate];
    // 轮询在推送 admit 全部走完之后才回来：它手里那份 pending 快照已经作废。
    collectDelay = 8;
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api));
    // 注册即发起一次轮询；推送紧随其后，两条路径的结果都指向同一条 pending。
    push(candidate);
    await settle(12);

    expect(spy.appended).toHaveLength(1);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-stale']);
    ctx.release();
  });

  test('自动 admit 之后再点「确认加入」什么都不做，也不要凭据', async () => {
    const { pending, candidate } = await fixture('e-late');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });
    const prompt = promptSpy();

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api, prompt.prompt));
    push(candidate);
    await settle();
    expect(spy.appended).toHaveLength(1);

    await ctx.confirmManually('e-late');
    expect(prompt.requests).toBe(0);
    expect(spy.appended).toHaveLength(1);
    ctx.release();
  });

  test('坏证书之后来了有效证书：判定失败的提示被清掉，按钮重新出现', async () => {
    const { pending, candidate } = await fixture('e-recover');
    // passkey 用户：证书到了也不自动签，正好停在「待确认」那一格。
    rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(spy.api));
    push({ certificate: candidate.certificate, certSig: encodeBase64url(new Uint8Array(64)) });
    await settle();
    expect(getEnrollmentEngineState().invalidById['e-recover']).toBe('nodes.enrollment.badCertSig');

    push(candidate);
    await settle();
    expect(getEnrollmentEngineState().invalidById['e-recover']).toBeUndefined();
    expect(getEnrollmentEngineState().certificateReadyIds).toEqual(['e-recover']);
    ctx.release();
  });
});

describe('手动确认', () => {
  test('hub 未确认时原样重发同一份字节，不再要凭据、不重新签名', async () => {
    const { pending } = await fixture('e-7');
    addPendingEnrollment(pending);
    const record = { bytes: 'YWJj', sig: 'ZGVm' };
    const stash = apiSpy({ ok: false, code: 'HUB_TIMEOUT' });
    expect(await submitAdmitRecord(stash.api, 'e-7', record)).toEqual({ kind: 'unconfirmed' });
    expect(getEnrollmentEngineState().hubUnconfirmedIds).toEqual(['e-7']);

    const prompt = promptSpy();
    const spy = apiSpy({ ok: true, hubAck: true });
    const ctx = registerAdmitContext(context(spy.api, prompt.prompt));
    await ctx.confirmManually('e-7');

    expect(prompt.requests).toBe(0);
    expect(spy.appended).toEqual([record]);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-7']);
    ctx.release();
  });

  test('没有暂存记录时向用户要凭据；用户取消则什么都不做', async () => {
    const { pending } = await fixture('e-8');
    addPendingEnrollment(pending);
    const prompt = promptSpy();
    const spy = apiSpy({ ok: true, hubAck: true });
    const ctx = registerAdmitContext(context(spy.api, prompt.prompt));
    await ctx.confirmManually('e-8');

    expect(prompt.requests).toBe(1);
    expect(spy.appended).toHaveLength(0);
    expect(listPendingEnrollments()).toHaveLength(1);
    ctx.release();
  });

  test('用的是发起按钮那个消费方的凭据对话框，而不是最后注册的那个', async () => {
    const { pending } = await fixture('e-bind');
    addPendingEnrollment(pending);
    const page = promptSpy();
    const panel = promptSpy();
    const spy = apiSpy({ ok: true, hubAck: true });
    const pageCtx = registerAdmitContext(context(spy.api, page.prompt));
    const panelCtx = registerAdmitContext(context(spy.api, panel.prompt));

    await pageCtx.confirmManually('e-bind');
    expect(page.requests).toBe(1);
    expect(panel.requests).toBe(0);

    panelCtx.release();
    pageCtx.release();
  });

  test('已经注销的消费方按钮不再生效', async () => {
    const { pending } = await fixture('e-dead');
    addPendingEnrollment(pending);
    const prompt = promptSpy();
    const spy = apiSpy({ ok: true, hubAck: true });
    const ctx = registerAdmitContext(context(spy.api, prompt.prompt));
    ctx.release();

    await ctx.confirmManually('e-dead');
    expect(prompt.requests).toBe(0);
  });

  test('取消清掉本地 pending、可重发记录与该 id 的全部投影', async () => {
    const { pending } = await fixture('e-9');
    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(apiSpy({ ok: true, hubAck: true }).api));
    await submitAdmitRecord(apiSpy({ ok: false, code: 'HUB_TIMEOUT' }).api, 'e-9', {
      bytes: 'YWJj',
      sig: 'ZGVm',
    });
    expect(listUnconfirmedRecordIds()).toEqual(['e-9']);

    cancelPending(pending);

    expect(listPendingEnrollments()).toHaveLength(0);
    expect(listUnconfirmedRecordIds()).toEqual([]);
    expect(getEnrollmentEngineState().hubUnconfirmedIds).toEqual([]);
    expect(getEnrollmentEngineState().cancelledIds).toEqual(['e-9']);
    expect(getEnrollmentEngineState().clearedIds).toContain('e-9');
    ctx.release();
  });
});

describe('append 结果未知', () => {
  test('请求抛异常时留住已签字节，下一次只重发它，绝不按新 head 重签', async () => {
    const { pending, candidate } = await fixture('e-throw');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    let calls = 0;
    const appended: { bytes: string; sig: string }[] = [];
    const api = {
      keyLogHead: () =>
        Promise.resolve({ seq: 5, hash: encodeBase64url(new Uint8Array(32).fill(7)) }),
      appendKeyLog: (body: { bytes: string; sig: string }) => {
        calls += 1;
        appended.push(body);
        // 第一次连接断在半路：服务端到底落没落库无从判断。
        if (calls === 1) return Promise.reject(new Error('network down'));
        return Promise.resolve({ ok: true as const, hubAck: true });
      },
    } as unknown as AuthApi;

    addPendingEnrollment(pending);
    const ctx = registerAdmitContext(context(api));
    push(candidate);
    await settle();

    const stored = unconfirmedRecord('e-throw');
    expect(stored).not.toBeNull();
    expect(stored).toEqual(appended[0]);
    expect(listPendingEnrollments()).toHaveLength(1);

    // 轮询再看到同一张证书：重发的必须是同一份字节。
    push(candidate);
    await settle();
    expect(appended).toHaveLength(2);
    expect(appended[1]).toEqual(appended[0]);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-throw']);
    ctx.release();
  });
});

describe('过期清理', () => {
  test('引擎自己扫过期 pending，join 串随 clearedIds 一起消失', async () => {
    const { pending } = await fixture('e-10');
    addPendingEnrollment(pending);
    await submitAdmitRecord(apiSpy({ ok: false, code: 'HUB_TIMEOUT' }).api, 'e-10', {
      bytes: 'YWJj',
      sig: 'ZGVm',
    });
    configureEnrollmentEngineForTest({ now: () => pending.exp + 1 });
    const ctx = registerAdmitContext(context(apiSpy({ ok: true, hubAck: true }).api));

    expect(listPendingEnrollments()).toHaveLength(0);
    expect(getEnrollmentEngineState().expiredIds).toEqual(['e-10']);
    expect(getEnrollmentEngineState().clearedIds).toContain('e-10');
    // 过期同样要丢掉可重发记录，否则它会一直挂在「hub 未确认」上。
    expect(listUnconfirmedRecordIds()).toEqual([]);
    // pending 没了，回路不该开着。
    expect(enrollmentEngineDebugForTest().watching).toBe(false);
    ctx.release();
  });
});

describe('resetEnrollmentEngineForTest', () => {
  test('撤掉回路与上下文，并把协作 store 一起归零', async () => {
    const { pending } = await fixture('e-11');
    addPendingEnrollment(pending);
    await submitAdmitRecord(apiSpy({ ok: false, code: 'HUB_TIMEOUT' }).api, 'e-11', {
      bytes: 'YWJj',
      sig: 'ZGVm',
    });
    rememberSigner({ kind: 'root', rootKey: rootKeyFromSeed(new Uint8Array(32).fill(9)) }, NOW);
    registerAdmitContext(context(apiSpy({ ok: true, hubAck: true }).api));
    expect(enrollmentEngineDebugForTest()).toMatchObject({ contexts: 1, watching: true });

    resetEnrollmentEngineForTest();
    expect(enrollmentEngineDebugForTest()).toEqual({
      contexts: 0,
      watching: false,
      sweeping: false,
    });
    expect(getEnrollmentEngineState()).toEqual({
      busyPendingId: null,
      admittedIds: [],
      expiredIds: [],
      cancelledIds: [],
      clearedIds: [],
      hubUnconfirmedIds: [],
      certificateReadyIds: [],
      invalidById: {},
    });
    expect(pushHandlers.size).toBe(0);
    expect(listPendingEnrollments()).toHaveLength(0);
    expect(listUnconfirmedRecordIds()).toEqual([]);
  });
});
