// hub 管理 API 的浏览器客户端。
//
// hub 的管理面挂在 **hub 机的 node** 上（`/n/<hubNodeId>/api/hub/*`），鉴权就是该 node 的
// node-session。因此这里一律走 entry 的 ApiClient（baseUrl 为空），由 entry 的 `/n/:id`
// 转发器代到 hub 机；**不能**用当前路由 node 的 ApiClient，否则会变成 `/n/a/n/hub/...`。

import { type ApiClient, SELF_NODE_ID, defaultApiClient, resolveNodeUrl } from '@tmex/api-client';
import type { HubEnrollmentStatus } from '@tmex/api-client/auth/index';
import { readCodedError } from '@tmex/api-client/json-mutation';
import type { HubRoleRequest, HubRoleTransition } from '@tmex/shared';

/**
 * key log 里这台 node 的接纳状态（`nodes.status` 之外的派生字段）。
 * `pending`：Hub 已发出证书，本地密钥日志还没有对应的 `admit-node`——它还不是 mesh 成员。
 */
export type HubAdmissionStatus = 'pending' | 'admitted' | 'revoked';

const ADMISSION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'admitted',
  'revoked',
] satisfies HubAdmissionStatus[]);

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
  /** 旧 Hub 不下发这一段，缺失即 `admitted`（老行为不变）。 */
  admission_status?: HubAdmissionStatus;
  /** 待批准行的 enrollment 编号；`admit-node` 的重发对账按它记。 */
  enrollment_id?: string;
  /** base64url(borsh(EnrollAuthorization))：待批准行才有，签 `admit-node` 要用。 */
  authorization?: string;
  /** base64url，64 字节。与 `authorization` 同批下发。 */
  authorization_sig?: string;
  /** base64url(borsh(Certificate))：已 admit 的 node 才有。 */
  certificate?: string;
  /** base64url，64 字节。与 `certificate` 同批下发。 */
  cert_sig?: string;
}

/** 未知值与缺失一律当 `admitted`：新字段不能让旧 Hub 的整张表变成「待批准」。 */
export function hubAdmissionStatus(row: Pick<HubNodeRow, 'admission_status'>): HubAdmissionStatus {
  const value = row.admission_status;
  return value && ADMISSION_STATUSES.has(value) ? value : 'admitted';
}

/** 空串与非字符串一律抹成 `undefined`：畸形材料留到签名那一步才炸没有任何好处。 */
function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 归一化节点表：补齐 `admission_status`，并只留下字符串形态的 admit 材料。 */
export function normalizeHubNodeRows(rows: HubNodeRow[]): HubNodeRow[] {
  return rows.map((row) => ({
    ...row,
    admission_status: hubAdmissionStatus(row),
    enrollment_id: textField(row.enrollment_id),
    authorization: textField(row.authorization),
    authorization_sig: textField(row.authorization_sig),
    certificate: textField(row.certificate),
    cert_sig: textField(row.cert_sig),
  }));
}

/**
 * `POST /api/mesh/relay/enrollments` 的逐台中继结果：enrollment 会 fan-out 到全部已授权中继，
 * 只有 `accepted` 的那几台真的能 redeem。旧节点不下发这一段（或只给 `string[]` 地址表）。
 */
export interface EnrollmentRelayResult {
  url: string;
  /** 32 位小写 hex；这一台自己签发的租户编号。 */
  tenantId: string;
  /** base64url，32 字节；只有 `accepted` 的那几台带。 */
  token?: string;
  accepted: boolean;
  /** 未接受的原因（超时 / 配额 / 拒绝）。 */
  error?: string;
}

export interface HubEnrollmentCreated {
  ok: boolean;
  id: string;
  expires_at: number;
  /** 中继模式专有：enrollment 的 fan-out 结果；hub 模式不下发。 */
  relays?: string[] | EnrollmentRelayResult[];
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

/** hub 的错误体除了标准契约还可能只带一个顶层 `code`，那一档走 `pick`。 */
function readError(res: Response, fallback: string): Promise<HubApiError> {
  return readCodedError(
    res,
    fallback,
    (code, _message, status) => new HubApiError(code, status),
    (body, status) => {
      if (!body || typeof body !== 'object') return undefined;
      const { error, code } = body as { error?: unknown; code?: unknown };
      if (error !== undefined) return undefined;
      return typeof code === 'string' ? new HubApiError(code, status) : undefined;
    }
  );
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
    return normalizeHubNodeRows(body.nodes ?? []);
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

/**
 * 中继模式下的 enrollment 通道：路径换成本机的 `/api/mesh/relay/*`（enrollment 由本机 uplink
 * 转发到中继），`createEnrollment` / `getEnrollment` 的报文、鉴权与错误解析与 hub 完全一致，
 * 因此直接复用 `HubApi` 的方法体，只换 `path()`。
 *
 * 其余方法在中继模式下**没有对应路由**：中继不提供节点列表与改名（成员表在各节点本地，
 * 名字由节点自持）。误调一律当场报错，绝不静默打到一条不存在的路径上。
 */
export class RelayEnrollmentApi extends HubApi {
  constructor(client: ApiClient = defaultApiClient) {
    super(SELF_NODE_ID, client);
  }

  override path(suffix: string): string {
    return `/api/mesh/relay${suffix}`;
  }

  override listNodes(): Promise<HubNodeRow[]> {
    return Promise.reject(new HubApiError('RELAY_NO_NODE_LIST', 0));
  }

  override rename(): Promise<void> {
    return Promise.reject(new HubApiError('RELAY_RENAME_UNSUPPORTED', 0));
  }
}

/** 中继模式下唯一需要的那个 enrollment 通道实例（打的永远是本机）。 */
export const defaultRelayEnrollmentApi = new RelayEnrollmentApi();
