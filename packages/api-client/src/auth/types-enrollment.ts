/** `GET /api/mesh/relay/enrollments/:id`：redeem 后带证书。 */
export interface EnrollmentStatus {
  status: 'pending' | 'redeemed';
  enroll_pk: string;
  /** base64url(borsh(Certificate))；`status==='redeemed'` 时存在。 */
  certificate?: string;
  /** base64url，64 字节。 */
  cert_sig?: string;
  node_id?: string;
}

/**
 * `POST /api/mesh/relay/enrollments` 的 201。
 * 节点侧路由也可能下发 camelCase 的 `expiresAt`（与 `expires_at` 同义）。
 */
export interface EnrollmentCreated {
  ok?: boolean;
  id: string;
  expires_at?: number;
  expiresAt?: number;
  /** 中继 fan-out 结果：地址表或逐台 `{url, accepted}`。 */
  relays?: string[] | EnrollmentRelayWire[];
  /** 加入命令用的对外可达地址。 */
  public_url?: string;
  /** self-signed CA 的 SPKI sha256 hex；无 CA 时为 null。 */
  ca_fingerprint?: string | null;
  /** self-signed CA PEM；浏览器不消费，给 CLI / 对端 pin 用。 */
  ca_cert_pem?: string | null;
}

/** enrollment fan-out 的逐台中继结果（新节点下发；旧节点可能只给地址表）。 */
export interface EnrollmentRelayWire {
  url: string;
  tenantId: string;
  token?: string;
  accepted: boolean;
  error?: string;
}
