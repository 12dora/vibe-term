// 宿主级 enrollment 引擎：一条监听回路 + 一条 admit 流水线。
//
// 核心不变量：无论挂了几个消费方（设置页 + 侧滑面板），同一张证书都只能签出**一条**
// `admit-node`。两条就是同一个 head 上的两个 seq，hub 只收得下一条，另一条永久 `seq_gap`。

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const {
  createEnrollment,
  createNodeCertificate,
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
  setPendingStorage,
  submitAdmitRecord,
} = await import('./enrollment');
const {
  cancelPending,
  configureEnrollmentEngineForTest,
  confirmManually,
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

function promptSpy(): PromptSpy {
  const spy: PromptSpy = {
    requests: 0,
    prompt: {
      request: () => {
        spy.requests += 1;
        return Promise.resolve(null);
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

let collectCalls = 0;
let collectResult: CertificateCandidate[] = [];

beforeEach(() => {
  resetEnrollmentEngineForTest();
  pushHandlers.clear();
  starts = 0;
  collectCalls = 0;
  collectResult = [];
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
    collect: () => {
      collectCalls += 1;
      return Promise.resolve(collectResult);
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
    const offFirst = registerAdmitContext(context(first.api));
    const offSecond = registerAdmitContext(context(second.api));
    // 推送订阅与轮询各一份：第二个消费方没有再开一条。
    expect(starts).toBe(1);
    expect(pushHandlers.size).toBe(1);
    await flush();
    expect(collectCalls).toBe(1);
    // 证书只被签了一次，且交给最后注册的上下文。
    expect(first.appended).toHaveLength(0);
    expect(second.appended).toHaveLength(1);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-1']);
    expect(listPendingEnrollments()).toHaveLength(0);

    offSecond();
    offFirst();
  });

  test('同一张证书连续到达两次也只签一次（模块级 in-flight 锁）', async () => {
    const { pending, candidate } = await fixture('e-2');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const off = registerAdmitContext(context(spy.api));
    push(candidate);
    push(candidate);
    await flush();

    expect(spy.appended).toHaveLength(1);
    off();
  });

  test('注销后回落到上一个上下文，全部注销则停掉回路', async () => {
    const one = await fixture('e-3');
    const two = await fixture('e-4');
    rememberSigner({ kind: 'root', rootKey }, NOW);
    const first = apiSpy({ ok: true, hubAck: true });
    const second = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(one.pending);
    const offFirst = registerAdmitContext(context(first.api));
    const offSecond = registerAdmitContext(context(second.api));
    push(one.candidate);
    await flush();
    expect(second.appended).toHaveLength(1);

    // 后注册的走了：回落到第一个上下文，回路继续跑。
    offSecond();
    expect(enrollmentEngineDebugForTest().contexts).toBe(1);
    addPendingEnrollment(two.pending);
    rememberSigner({ kind: 'root', rootKey }, NOW);
    push(two.candidate);
    await flush();
    expect(first.appended).toHaveLength(1);
    expect(second.appended).toHaveLength(1);

    // 没有消费方了：推送订阅与轮询都撤掉。
    offFirst();
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
    const offPage = registerAdmitContext({ ...context(spy.api), hubApi });
    const offPanel = registerAdmitContext(context(spy.api));
    await flush();

    expect(spy.appended).toHaveLength(1);
    offPanel();
    offPage();
  });

  test('passkey 用户不自动签，只把 pending 标成「证书已到」等手动确认', async () => {
    const { pending, candidate } = await fixture('e-5');
    rememberSigner({ kind: 'passkey', credentialId: 'cred-1' }, NOW);
    const spy = apiSpy({ ok: true, hubAck: true });

    addPendingEnrollment(pending);
    const off = registerAdmitContext(context(spy.api));
    push(candidate);
    await flush();

    expect(spy.appended).toHaveLength(0);
    expect(getEnrollmentEngineState().certificateReadyIds).toEqual(['e-5']);
    expect(listPendingEnrollments()).toHaveLength(1);
    off();
  });

  test('证书对不上 pending 时按 id 记下提示 key', async () => {
    const { pending, candidate } = await fixture('e-6');
    const spy = apiSpy({ ok: true, hubAck: true });
    addPendingEnrollment(pending);
    const off = registerAdmitContext(context(spy.api));
    // 换一份坏签名：`bad_cert_sig`
    push({ certificate: candidate.certificate, certSig: encodeBase64url(new Uint8Array(64)) });
    await flush();

    expect(getEnrollmentEngineState().invalidById['e-6']).toBe('nodes.enrollment.badCertSig');
    off();
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
    const off = registerAdmitContext(context(spy.api, prompt.prompt));
    await confirmManually(pending);

    expect(prompt.requests).toBe(0);
    expect(spy.appended).toEqual([record]);
    expect(getEnrollmentEngineState().admittedIds).toEqual(['e-7']);
    off();
  });

  test('没有暂存记录时向用户要凭据；用户取消则什么都不做', async () => {
    const { pending } = await fixture('e-8');
    addPendingEnrollment(pending);
    const prompt = promptSpy();
    const spy = apiSpy({ ok: true, hubAck: true });
    const off = registerAdmitContext(context(spy.api, prompt.prompt));
    await confirmManually(pending);

    expect(prompt.requests).toBe(1);
    expect(spy.appended).toHaveLength(0);
    expect(listPendingEnrollments()).toHaveLength(1);
    off();
  });

  test('取消只删本地 pending 并把 id 记入 clearedIds', async () => {
    const { pending } = await fixture('e-9');
    addPendingEnrollment(pending);
    const off = registerAdmitContext(context(apiSpy({ ok: true, hubAck: true }).api));
    cancelPending(pending);

    expect(listPendingEnrollments()).toHaveLength(0);
    expect(getEnrollmentEngineState().cancelledIds).toEqual(['e-9']);
    expect(getEnrollmentEngineState().clearedIds).toContain('e-9');
    off();
  });
});

describe('过期清理', () => {
  test('引擎自己扫过期 pending，join 串随 clearedIds 一起消失', async () => {
    const { pending } = await fixture('e-10');
    addPendingEnrollment(pending);
    configureEnrollmentEngineForTest({ now: () => pending.exp + 1 });
    const off = registerAdmitContext(context(apiSpy({ ok: true, hubAck: true }).api));

    expect(listPendingEnrollments()).toHaveLength(0);
    expect(getEnrollmentEngineState().expiredIds).toEqual(['e-10']);
    expect(getEnrollmentEngineState().clearedIds).toContain('e-10');
    // pending 没了，回路不该开着。
    expect(enrollmentEngineDebugForTest().watching).toBe(false);
    off();
  });
});

describe('resetEnrollmentEngineForTest', () => {
  test('撤掉回路与上下文并清空状态', async () => {
    const { pending } = await fixture('e-11');
    addPendingEnrollment(pending);
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
  });
});
