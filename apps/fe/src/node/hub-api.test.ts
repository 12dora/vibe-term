// hub 管理 API 客户端：路径拼装（角色接口打的是**参数给的**那台 hub）与错误码映射。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { HubApi, HubApiError, hubAdmissionStatus } from './hub-api';

const HUB = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';
const OTHER = '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b';

function client(handler: (path: string, init?: RequestInit) => Response): {
  api: HubApi;
  calls: Array<{ path: string; init?: RequestInit }>;
} {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const transport = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  return { api: new HubApi(HUB, new ApiClient('', transport)), calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HubApi.role', () => {
  test('打的是参数给的那台 hub，不是实例绑定的那台', async () => {
    const { api, calls } = client(() =>
      json(202, {
        operationId: 'op-1',
        targetHubId: OTHER,
        mode: 'active',
        writerEpoch: 6,
        phase: 'accepted',
        error: null,
        startedAt: 1,
        updatedAt: 1,
      })
    );
    const transition = await api.role(OTHER, {
      mode: 'active',
      writerEpoch: 6,
      operationId: 'op-1',
    });
    expect(transition.phase).toBe('accepted');
    expect(calls[0]?.path).toBe(`/n/${OTHER}/api/hub/role`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      mode: 'active',
      writerEpoch: 6,
      operationId: 'op-1',
    });
  });

  test('roleStatus 带上 operationId 查询串', async () => {
    const { api, calls } = client(() =>
      json(200, {
        operationId: 'op 2',
        targetHubId: OTHER,
        mode: 'standby',
        writerEpoch: null,
        phase: 'complete',
        error: null,
        startedAt: 1,
        updatedAt: 2,
      })
    );
    expect((await api.roleStatus(OTHER, 'op 2')).phase).toBe('complete');
    expect(calls[0]?.path).toBe(`/n/${OTHER}/api/hub/role/status?operationId=op%202`);
  });

  test('404 / 405 一律折成 HUB_ROLE_UNSUPPORTED：旧版本目标没有这套接口', async () => {
    for (const status of [404, 405]) {
      const { api } = client(() => new Response('', { status }));
      const err = await api
        .role(OTHER, { mode: 'standby', operationId: 'op-3' })
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(HubApiError);
      expect((err as HubApiError).code).toBe('HUB_ROLE_UNSUPPORTED');
      expect((err as HubApiError).status).toBe(status);
    }
  });

  test('其它错误原样带出后端的 code', async () => {
    const { api } = client(() => json(409, { code: 'HUB_EPOCH_STALE' }));
    const err = await api
      .role(OTHER, { mode: 'active', writerEpoch: 1, operationId: 'op-4' })
      .catch((error: unknown) => error);
    expect((err as HubApiError).code).toBe('HUB_EPOCH_STALE');
    expect((err as HubApiError).status).toBe(409);
  });

  test('读不出 body 时退到通用码', async () => {
    const { api } = client(() => new Response('nope', { status: 500 }));
    const err = await api.roleStatus(OTHER, 'op-5').catch((error: unknown) => error);
    expect((err as HubApiError).code).toBe('hub_role_failed');
  });
});

describe('HubApi.listNodes 的 admission 归一化', () => {
  test('缺失 / 未知的 admission_status 一律当已接纳，旧 Hub 行为不变', async () => {
    const { api } = client(() =>
      json(200, {
        nodes: [
          { id: 'n1', name: 'a', status: 'enrolled', online: true },
          { id: 'n2', name: 'b', status: 'enrolled', online: true, admission_status: 'weird' },
        ],
      })
    );
    const rows = await api.listNodes();
    expect(rows.map((row) => row.admission_status)).toEqual(['admitted', 'admitted']);
  });

  test('pending 行原样保留，admit 材料只留字符串', async () => {
    const { api } = client(() =>
      json(200, {
        nodes: [
          {
            id: 'n3',
            name: 'c',
            status: 'enrolled',
            online: false,
            admission_status: 'pending',
            enrollment_id: 'enr-1',
            authorization: 'auth',
            authorization_sig: 'auth-sig',
            certificate: 'cert',
            cert_sig: '',
          },
        ],
      })
    );
    const [row] = await api.listNodes();
    expect(row.admission_status).toBe('pending');
    expect(row.enrollment_id).toBe('enr-1');
    expect(row.certificate).toBe('cert');
    // 空串等于没有：留到签名那一步才炸没有任何好处。
    expect(row.cert_sig).toBeUndefined();
  });

  test('revoked 原样透出', async () => {
    const { api } = client(() =>
      json(200, {
        nodes: [
          { id: 'n4', name: 'd', status: 'revoked', online: false, admission_status: 'revoked' },
        ],
      })
    );
    expect((await api.listNodes())[0].admission_status).toBe('revoked');
  });
});

describe('hubAdmissionStatus', () => {
  test('只认三个契约值', () => {
    expect(hubAdmissionStatus({ admission_status: 'pending' })).toBe('pending');
    expect(hubAdmissionStatus({ admission_status: 'revoked' })).toBe('revoked');
    expect(hubAdmissionStatus({})).toBe('admitted');
    expect(hubAdmissionStatus({ admission_status: 'ok' as never })).toBe('admitted');
  });
});
