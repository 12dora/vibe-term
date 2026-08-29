// hub 管理 API 的浏览器客户端。
//
// hub 的管理面挂在 **hub 机的 node** 上（`/n/<hubNodeId>/api/hub/*`），鉴权就是该 node 的
// node-session。因此这里一律走 entry 的 ApiClient（baseUrl 为空），由 entry 的 `/n/:id`
// 转发器代到 hub 机；**不能**用当前路由 node 的 ApiClient，否则会变成 `/n/a/n/hub/...`。

import { type ApiClient, defaultApiClient, resolveNodeUrl } from '@tmex/api-client';
import type { HubEnrollmentStatus } from '@tmex/api-client/auth/index';

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
  /** base64url(borsh(Certificate))：已 admit 的 node 才有。 */
  certificate?: string;
  /** base64url，64 字节。与 `certificate` 同批下发。 */
  cert_sig?: string;
}

export interface HubEnrollmentCreated {
  ok: boolean;
  id: string;
  expires_at: number;
  /** hub 的对外可达地址；join 命令**只能**用它。 */
  public_url?: string;
  /** self-signed CA 的 SPKI sha256 hex；拼进 join 串 v2 段。 */
  ca_fingerprint?: string | null;
  /** self-signed CA PEM；浏览器不消费，给 CLI / 对端 pin 用。 */
  ca_cert_pem?: string | null;
}

export type { HubEnrollmentStatus };

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

  /**
   * `GET /n/<hub>/api/hub/enrollments/:id`：redeem 后带 `{certificate, cert_sig, node_id}`。
   * `/mesh/ws` 的 `ENROLL_REDEEMED` 推送丢失时（页面刚打开、WS 断线）由它兜底。
   */
  async getEnrollment(id: string): Promise<HubEnrollmentStatus> {
    const res = await this.client.fetch(this.path(`/enrollments/${encodeURIComponent(id)}`));
    if (!res.ok) throw await readError(res, 'enrollment_status_failed');
    return (await res.json()) as HubEnrollmentStatus;
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
