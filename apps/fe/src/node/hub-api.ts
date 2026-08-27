// hub 管理 API 的浏览器客户端。
//
// hub 的管理面挂在 **hub 机的 node** 上（`/n/<hubNodeId>/api/hub/*`），鉴权就是该 node 的
// node-session。因此这里一律走 entry 的 ApiClient（baseUrl 为空），由 entry 的 `/n/:id`
// 转发器代到 hub 机；**不能**用当前路由 node 的 ApiClient，否则会变成 `/n/a/n/hub/...`。

import { type ApiClient, defaultApiClient, resolveNodeUrl } from '@tmex/api-client';

/** `GET /n/<hub>/api/hub/nodes` 的单行（见 `apps/gateway/src/hub/hub-runtime.ts`）。 */
export interface HubNodeRow {
  id: string;
  name: string;
  /** `active` / `revoked` 等，来自 `nodes.status` */
  status: string;
  online: boolean;
  version: string | null;
  last_seen_at: number | null;
  direct_capable: boolean;
  /**
   * base64url(borsh(Certificate))。**后端目前不返回**，是 admit 流程能自动完成的前提，
   * 见 `sub/f4-3-result.md`「后端待补」。存在时 `enroll_pk` 匹配即可自动签 `admit-node`。
   */
  certificate?: string;
  /** base64url，64 字节。与 `certificate` 同批下发。 */
  cert_sig?: string;
}

export interface HubEnrollmentCreated {
  ok: boolean;
  id: string;
  expires_at: number;
}

export class HubApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = 'HubApiError';
  }
}

async function readError(res: Response, fallback: string): Promise<HubApiError> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === 'string') return new HubApiError(body.error, res.status);
    if (typeof body.code === 'string') return new HubApiError(body.code, res.status);
  } catch {
    // 落到 fallback
  }
  return new HubApiError(fallback, res.status);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export class HubApi {
  constructor(
    readonly hubNodeId: string,
    private readonly client: ApiClient = defaultApiClient
  ) {}

  path(suffix: string): string {
    return resolveNodeUrl(this.hubNodeId, `/api/hub${suffix}`);
  }

  async listNodes(): Promise<HubNodeRow[]> {
    const res = await this.client.fetch(this.path('/nodes'));
    if (!res.ok) throw await readError(res, 'hub_nodes_failed');
    const body = (await res.json()) as { nodes?: HubNodeRow[] };
    return body.nodes ?? [];
  }

  async rename(nodeId: string, name: string): Promise<void> {
    const res = await this.client.fetch(this.path(`/nodes/${encodeURIComponent(nodeId)}/rename`), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await readError(res, 'rename_failed');
  }

  /** `bytes`/`sig` 是签好的 `revoke-node` 记录（base64url）；hub 会自己把它 append 进 key-log。 */
  async revoke(nodeId: string, record: { bytes: string; sig: string }): Promise<void> {
    const res = await this.client.fetch(this.path(`/nodes/${encodeURIComponent(nodeId)}/revoke`), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(record),
    });
    if (!res.ok) throw await readError(res, 'revoke_failed');
  }

  async createEnrollment(body: {
    enroll_pk: string;
    authorization: string;
    authorization_sig: string;
    exp: number;
  }): Promise<HubEnrollmentCreated> {
    const res = await this.client.fetch(this.path('/enrollments'), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await readError(res, 'enrollment_failed');
    return (await res.json()) as HubEnrollmentCreated;
  }
}
