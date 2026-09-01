// hub 管理 API 的浏览器客户端。
//
// hub 的管理面挂在 **hub 机的 node** 上（`/n/<hubNodeId>/api/hub/*`），鉴权就是该 node 的
// node-session。因此这里一律走 entry 的 ApiClient（baseUrl 为空），由 entry 的 `/n/:id`
// 转发器代到 hub 机；**不能**用当前路由 node 的 ApiClient，否则会变成 `/n/a/n/hub/...`。

import { type ApiClient, SELF_NODE_ID, defaultApiClient, resolveNodeUrl } from '@tmex/api-client';
import type { HubEnrollmentStatus } from '@tmex/api-client/auth/index';
import type { HubRoleRequest, HubRoleTransition } from '@tmex/shared';

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

/** 角色接口挂在目标 hub 机的 node 上，与 `HubApi` 实例自身绑定的那台无关。 */
function rolePath(hubNodeId: string): string {
  return resolveNodeUrl(hubNodeId, '/api/hub/role');
}

/**
 * 目标版本没有这套接口时入口转发回 404 / 405（路由不存在 / 方法不允许），
 * 一律折成 `HUB_ROLE_UNSUPPORTED`——对用户来说这两种都是「目标须先升级」。
 */
async function readRoleError(res: Response): Promise<HubApiError> {
  if (res.status === 404 || res.status === 405) {
    return new HubApiError('HUB_ROLE_UNSUPPORTED', res.status);
  }
  return readError(res, 'hub_role_failed');
}

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

  /**
   * `POST /n/<hub>/api/hub/role`：把目标 hub 切成主 / 备。目标由参数指定，**不是**入口挂载的
   * 那一台——切换的常态就是「站在备 Hub 这一行，把它升成主」。
   * 目标落库后自己重启，因此 202 之后它会有一段时间不可达，结论只能靠 `roleStatus` 回读。
   */
  async role(hubNodeId: string, req: HubRoleRequest): Promise<HubRoleTransition> {
    const res = await this.client.fetch(rolePath(hubNodeId), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(req),
    });
    if (!res.ok) throw await readRoleError(res);
    return (await res.json()) as HubRoleTransition;
  }

  /** `GET /n/<hub>/api/hub/role/status?operationId=`：回读一次过渡的当前阶段。 */
  async roleStatus(hubNodeId: string, operationId: string): Promise<HubRoleTransition> {
    const query = `?operationId=${encodeURIComponent(operationId)}`;
    const res = await this.client.fetch(`${rolePath(hubNodeId)}/status${query}`);
    if (!res.ok) throw await readRoleError(res);
    return (await res.json()) as HubRoleTransition;
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

/**
 * 不绑定具体 hub 的实例：`role` / `roleStatus` 的目标由参数给出，这里只借它的 ApiClient。
 * `SELF_NODE_ID` 让 `path()` 退化成入口自身的旧路径，不会指向某台猜出来的 hub。
 */
export const defaultHubApi = new HubApi(SELF_NODE_ID);
