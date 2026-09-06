// 开关提交：先签 `notification-sink` 记录，记录落地后才动本机开关。

import { describe, expect, test } from 'bun:test';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { ApiClient } from '@tmex/api-client';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { MESH_NOTIFICATION_ROUTE } from '@tmex/shared';
import { deriveSeed, encodeBase64url, rootKeyFromSeed } from '@tmex/shared/auth';
import {
  MESH_SINK_NO_MODE,
  MESH_SINK_NO_NODE_ID,
  MeshSinkError,
  meshSinkErrorText,
  submitMeshSinkToggle,
} from './mesh-sink-toggle';

const NODE_ID = 'ab'.repeat(16);
const MODE = { uid: 'user-1', rootEpoch: 0 };

type Call = { path: string; init?: RequestInit };

function apiClient(calls: Call[]): ApiClient {
  return {
    fetch: (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return Promise.resolve(
        new Response(JSON.stringify({ supported: true, selfEnabled: true, sinks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    },
  } as unknown as ApiClient;
}

function authApi(appended: unknown[], result: unknown = { ok: true, hubAck: true }): AuthApi {
  return {
    keyLogHead: () =>
      Promise.resolve({ seq: 1, hash: encodeBase64url(new Uint8Array(32).fill(3)) }),
    appendKeyLog: (body: unknown) => {
      appended.push(body);
      return Promise.resolve(result);
    },
  } as unknown as AuthApi;
}

const signer: RecordSigner = {
  kind: 'root',
  rootKey: rootKeyFromSeed(
    await deriveSeed('pw', {
      salt: new Uint8Array(16).fill(0x05),
      memory_kib: 64,
      iterations: 1,
      parallelism: 1,
    })
  ),
};

function deps(overrides: Partial<Parameters<typeof submitMeshSinkToggle>[0]> = {}) {
  const calls: Call[] = [];
  const appended: unknown[] = [];
  return {
    calls,
    appended,
    input: {
      apiClient: apiClient(calls),
      authApi: authApi(appended),
      mode: MODE,
      selfNodeId: NODE_ID,
      withSigner: <T>(fn: (s: RecordSigner) => Promise<T>) => fn(signer).then((v) => v as T | null),
      ...overrides,
    },
  };
}

describe('submitMeshSinkToggle', () => {
  test('记录签成后才 PUT 本机开关', async () => {
    const { calls, appended, input } = deps();
    const state = await submitMeshSinkToggle(input, true);
    expect(appended).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(MESH_NOTIFICATION_ROUTE);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: true });
    expect(state?.selfEnabled).toBe(true);
  });

  test('用户取消凭据交互：不写记录也不动开关', async () => {
    const { calls, input } = deps({ withSigner: () => Promise.resolve(null) });
    expect(await submitMeshSinkToggle(input, true)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('记录被拒（版本门）：抛错且不动本机开关', async () => {
    const appended: unknown[] = [];
    const calls: Call[] = [];
    const input = {
      apiClient: apiClient(calls),
      authApi: authApi(appended, { ok: false, code: 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES' }),
      mode: MODE,
      selfNodeId: NODE_ID,
      withSigner: <T>(fn: (s: RecordSigner) => Promise<T>) => fn(signer).then((v) => v as T | null),
    };
    await expect(submitMeshSinkToggle(input, true)).rejects.toThrow(
      'KEYLOG_TYPE_UNSUPPORTED_BY_NODES'
    );
    expect(calls).toEqual([]);
  });

  test('缺登录态 / 缺节点编号：前置失败，不发任何请求', async () => {
    const noMode = deps({ mode: null });
    await expect(submitMeshSinkToggle(noMode.input, true)).rejects.toMatchObject({
      code: MESH_SINK_NO_MODE,
    });
    const noNode = deps({ selfNodeId: null });
    await expect(submitMeshSinkToggle(noNode.input, true)).rejects.toMatchObject({
      code: MESH_SINK_NO_NODE_ID,
    });
    expect(noMode.calls).toEqual([]);
    expect(noNode.appended).toEqual([]);
  });
});

describe('meshSinkErrorText', () => {
  const t = (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;

  test('版本门给专句并带最低版本', () => {
    expect(meshSinkErrorText(t, 'KEYLOG_TYPE_UNSUPPORTED_BY_NODES')).toBe(
      'settings.notifications.mesh.nodesTooOld:{"minVersion":"1.1.39"}'
    );
  });

  test('前置失败给「无法保存」那一句', () => {
    expect(meshSinkErrorText(t, MESH_SINK_NO_MODE)).toBe('settings.notifications.mesh.unavailable');
    expect(meshSinkErrorText(t, MESH_SINK_NO_NODE_ID)).toBe(
      'settings.notifications.mesh.unavailable'
    );
  });

  test('其余落回错误表', () => {
    expect(meshSinkErrorText(t, 'KEY_LOG_FORK')).toBe(
      'auth.errors.KEY_LOG_FORK:{"defaultValue":"KEY_LOG_FORK"}'
    );
    expect(new MeshSinkError('boom').code).toBe('boom');
  });
});
