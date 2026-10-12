// 「生成加入码」把 `relayJoinTarget` 选出的那台中继交给 `createEnrollmentOnRelay`。
//
// bun test 没有 DOM：静态渲染一次拿到 `submit`，渲染结束后的 setState 在服务端是空操作，
// 所以断言落在打桩的 `createEnrollmentOnRelay` 收到的入参上。`mock.module` 是进程级的，
// 桩在本文件的用例之外原样转发给真实实现，免得污染 `relay-join.test.ts`。

import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { CreatedEnrollment } from '@/node/enrollment';
import type { CreateRelayEnrollmentInput } from '@/node/relay-join';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import { encodeBase64url } from '@vibeterm/shared/auth';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { ResolvedMode } from './types';
import type { CreateEnrollmentState } from './use-create-enrollment';

installWindowStorage();

const RelayJoinRuntime = await import('@/node/relay-join');
// 转发目标必须在打桩前抓下来，否则「未激活时转发」会变成自己调自己。
const realCreateEnrollmentOnRelay = RelayJoinRuntime.createEnrollmentOnRelay;

let intercept: ((input: CreateRelayEnrollmentInput) => Promise<CreatedEnrollment>) | null = null;

mock.module('@/node/relay-join', () => ({
  ...RelayJoinRuntime,
  createEnrollmentOnRelay: (input: CreateRelayEnrollmentInput) =>
    intercept ? intercept(input) : realCreateEnrollmentOnRelay(input),
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { resetMeshRelayStateForTest, setMeshRelayStateForTest } = await import('@/node/mesh-relay');
const { useCreateEnrollment } = await import('./use-create-enrollment');

const MODE: ResolvedMode = {
  mode: 'mesh',
  nodeId: '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e',
  uid: 'user-1',
  username: 'alice',
  kdfParams: { salt: 'AAAAAAAAAAAAAAAAAAAAAA', memory_kib: 65536, iterations: 3, parallelism: 1 },
  passkeysForThisOrigin: false,
  passkeyAvailable: false,
  rootEpoch: 0,
  rootPublicKey: encodeBase64url(new Uint8Array(32).fill(0x33)),
};

const API = {
  keyLogHead: () =>
    Promise.resolve({ seq: 0, hash: encodeBase64url(new Uint8Array(32)), rootEpoch: 0 }),
} as unknown as AuthApi;

const PROMPT: CredentialPromptHandle = {
  request: () => Promise.resolve({} as RecordSigner),
  withSigner: () => Promise.resolve(null),
  forget: () => undefined,
  dialog: null,
  passkeys: [],
};

afterEach(() => {
  intercept = null;
  resetMeshRelayStateForTest();
});

function mountHook(): CreateEnrollmentState {
  const captured: { state: CreateEnrollmentState | null } = { state: null };
  function Probe() {
    captured.state = useCreateEnrollment({ api: API, mode: MODE, prompt: PROMPT });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured.state) throw new Error('hook did not render');
  return captured.state;
}

describe('useCreateEnrollment', () => {
  test('多条中继：preferredUrl 与生成前的预览地址都是加入目标（主中继），不是 priority 最小的那台', async () => {
    const sh = { url: 'https://sh.example', tenantId: 'aa'.repeat(16) };
    const jp = { url: 'https://jp.example', tenantId: 'bb'.repeat(16) };
    const row = { online: true, attached: true, rttMs: null, lastError: null, kicked: false };
    setMeshRelayStateForTest({
      mode: 'relay',
      tenantId: 'cc'.repeat(16),
      multiAttach: true,
      relays: [
        { ...row, ...sh, priority: 0, role: 'secondary' },
        { ...row, ...jp, priority: 1, role: 'primary' },
      ],
      loadedAt: 1,
    });
    const calls: CreateRelayEnrollmentInput[] = [];
    intercept = (input) => {
      calls.push(input);
      return Promise.resolve({
        pending: { hubEnrollmentId: 'e1', exp: Date.now() + 60_000 },
        joinToken: 'r3.test',
        publicUrl: jp.url,
      } as CreatedEnrollment);
    };

    const state = mountHook();
    expect(state.publicUrl).toBe(jp.url);
    await state.submit();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.preferredUrl).toBe(jp.url);
    expect(calls[0]?.uid).toBe('user-1');
  });

  test('本机不走中继：不建 enrollment', async () => {
    const calls: CreateRelayEnrollmentInput[] = [];
    intercept = (input) => {
      calls.push(input);
      return Promise.reject(new Error('unexpected'));
    };

    const state = mountHook();
    expect(state.publicUrl).toBeNull();
    await state.submit();

    expect(calls).toHaveLength(0);
  });
});
