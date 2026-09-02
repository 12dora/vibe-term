// 允许域名访问（节点级本地策略）REST 端点：`GET/PATCH /api/system/domain-access`。
// 通过 `/n/<id>` 前缀的 ApiClient 调用即可读写远端节点的策略。

import type { ApiClient } from './client';
import { defaultApiClient } from './client';

export type DomainAccessPolicy = {
  /** 是否允许经配置的公开域名访问网页与 API（默认 true）。 */
  allowed: boolean;
  /** 当前请求是否正经由配置的公开域名到达（仅 entry 自身请求有意义，转发请求恒为 false）。 */
  viaDomain: boolean;
  /** 参与判定的公开主机名集合（小写，不含 IP 字面量）。 */
  hosts: string[];
};

async function readPolicy(res: Response, fallback: string): Promise<DomainAccessPolicy> {
  if (!res.ok) {
    let code = fallback;
    try {
      const body = (await res.json()) as { error?: { code?: unknown } | string };
      const error = body.error;
      if (typeof error === 'string') code = error;
      else if (error && typeof error.code === 'string') code = error.code;
    } catch {}
    const err = new Error(code) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as DomainAccessPolicy;
}

export async function fetchDomainAccess(
  client: ApiClient = defaultApiClient
): Promise<DomainAccessPolicy> {
  const res = await client.fetch('/api/system/domain-access');
  return readPolicy(res, 'domain_access_load_failed');
}

export async function updateDomainAccess(
  allowed: boolean,
  client: ApiClient = defaultApiClient
): Promise<DomainAccessPolicy> {
  const res = await client.fetch('/api/system/domain-access', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowed }),
  });
  return readPolicy(res, 'domain_access_update_failed');
}
