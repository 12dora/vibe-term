// node 注册（enrollment）与 admit / revoke 的浏览器侧逻辑（设计 §2 步骤 1、3 与「撤销」）。
//
// 关键安全性质：
// - `enroll_sk` **不经过 hub**：只出现在浏览器内存 / sessionStorage 与展示给用户的 join 串里。
// - 只有 `certificate.enroll_pk` 等于本地 pending 的 `enroll_pk`、`cert_sig` 用该 `enroll_pk`
//   验证通过、且 pending 未过期时，才签 `admit-node`。不匹配的证书一律忽略并告警。
// - `sk_sess` 不能签任何记录，admit / revoke 必须当场用根钥（密码）或 passkey。

// 只从 key-log-actions 直接取：走 `@/auth` barrel 会把 React 组件一起拖进来。
import type { RecordSigner } from '@/auth/key-log-actions';
import { buildSignedRecord, enrollmentSignerFrom } from '@/auth/key-log-actions';
import { ProtocolMismatchError } from '@tmex/api-client/auth/index';
import type { KeyLogHead } from '@tmex/shared/auth';
import {
  JOIN_TOKEN_BYTES,
  JOIN_TOKEN_CHARS,
  createEnrollment,
  decodeBase64url,
  decodeCertificate,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeRevokeNodePayload,
  hexToBytes,
  verifyNodeCertificate,
} from '@tmex/shared/auth';
import type { HubApi } from './hub-api';

export const PENDING_STORAGE_KEY = 'tmex.enrollment.pending';

/**
 * sessionStorage 里的一条待确认 enrollment。二进制字段一律 base64url。
 *
 * **绝不包含 `enroll_sk`，也不包含含 `enroll_sk` 的 join 串**：只要落盘，任何后续加载的同源
 * 脚本就能取走 enrollment 私钥、伪造节点证书并抢先 redeem（见 F4-1 评审 Blocker）。
 * admit 只需要 `enroll_pk` + 授权 + 证书，这些都是公开数据，刷新页面后仍能停在「待确认」。
 * join 串只在内存里、只显示这一次。
 */
export interface PendingEnrollment {
  /** hub 返回的 enrollment id（轮询 `GET /api/hub/enrollments/:id` 用）。 */
  hubEnrollmentId: string;
  /** base64url，32 字节：一次性注册公钥。证书匹配的唯一依据。 */
  enrollPk: string;
  /** base64url(borsh(Authorization))。 */
  authorizationBytes: string;
  /** base64url，64 字节 / borsh(PasskeyAssertion)。 */
  authorizationSig: string;
  /** 授权过期时间（毫秒）。过期后 pending 不可再 admit。 */
  exp: number;
  /** 用户给新节点起的名字（非敏感，仅用于列表展示）。 */
  name: string | null;
  createdAt: number;
}

export interface CertificateCandidate {
  /** base64url(borsh(Certificate)) */
  certificate: string;
  /** base64url，64 字节 */
  certSig: string;
}

// ---------------------------------------------------------------------------
// pending 存储（内存 + sessionStorage）
// ---------------------------------------------------------------------------

export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storageOverride: PendingStorage | null = null;

/** 仅测试使用：注入内存 storage。 */
export function setPendingStorage(storage: PendingStorage | null): void {
  storageOverride = storage;
  cache = null;
  notify();
}

function storage(): PendingStorage | null {
  if (storageOverride) return storageOverride;
  const session = (globalThis as { sessionStorage?: PendingStorage }).sessionStorage;
  return session ?? null;
}

let cache: PendingEnrollment[] | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 可以落盘的字段——公开投影**只**由它们组成，多出来的一律丢掉。 */
const PUBLIC_FIELDS = [
  'hubEnrollmentId',
  'enrollPk',
  'authorizationBytes',
  'authorizationSig',
  'exp',
  'name',
  'createdAt',
] as const;

/**
 * 秘密味道的字段名。`enrollSk`（sk）、`joinToken`（token）都被它命中，
 * 将来若有别的分支往这里塞秘密，也会被同一条规则拦下。
 */
const SECRET_FIELD_RE = /sk|secret|token|seed|priv|password|passphrase|credential/i;

function isSecretLikeField(key: string): boolean {
  if ((PUBLIC_FIELDS as readonly string[]).includes(key)) return false;
  return SECRET_FIELD_RE.test(key);
}

/**
 * 反序列化守卫。带 `enrollSk` / `joinToken` 或任何秘密味道字段的记录一律丢弃（不迁移）：
 * 那是不该存在的秘密，读回来只会把它再写一遍。
 */
function isPending(value: unknown): value is PendingEnrollment {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(isSecretLikeField)) return false;
  return (
    typeof row.hubEnrollmentId === 'string' &&
    typeof row.enrollPk === 'string' &&
    typeof row.authorizationBytes === 'string' &&
    typeof row.authorizationSig === 'string' &&
    typeof row.exp === 'number'
  );
}

/** 只保留公开字段：来路不明的多余字段（含将来新增的秘密）都不会再被写回去。 */
function publicProjection(row: PendingEnrollment): PendingEnrollment {
  return {
    hubEnrollmentId: row.hubEnrollmentId,
    enrollPk: row.enrollPk,
    authorizationBytes: row.authorizationBytes,
    authorizationSig: row.authorizationSig,
    exp: row.exp,
    name: typeof row.name === 'string' ? row.name : null,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
  };
}

function writeStorage(rows: PendingEnrollment[]): void {
  const store = storage();
  if (!store) return;
  try {
    if (rows.length === 0) store.removeItem(PENDING_STORAGE_KEY);
    else store.setItem(PENDING_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // 隐私模式下 sessionStorage 会抛；内存态仍然有效，刷新后丢失即可。
  }
}

/**
 * 加载 + **就地净化**。
 *
 * 光把旧格式从内存结果里 `filter` 掉不够：含 `enroll_sk` 的原始 JSON 仍留在 sessionStorage 里，
 * 升级后同源脚本照样能取走 enrollment 私钥抢先 redeem（见 F4-fix 评审 Blocker）。
 * 因此只要读到的内容不是「恰好等于公开投影」，就**先删 key**（哪怕随后的回写抛异常，
 * 秘密也已经不在盘上了），再把公开投影写回去。
 *
 * 注意：本函数是 `useSyncExternalStore` 的 `getSnapshot`，**绝不能** `notify()`——
 * 那会在渲染期同步触发订阅者。净化只碰存储与 cache，快照本身在这一次读取里就是终值。
 */
export function listPendingEnrollments(): PendingEnrollment[] {
  if (cache) return cache;
  const store = storage();
  if (!store) {
    cache = [];
    return cache;
  }
  let raw: string | null = null;
  let rows: PendingEnrollment[] = [];
  try {
    raw = store.getItem(PENDING_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    rows = Array.isArray(parsed) ? parsed.filter(isPending).map(publicProjection) : [];
  } catch {
    rows = [];
  }
  const clean = rows.length === 0 ? null : JSON.stringify(rows);
  if (raw !== null && raw !== clean) {
    store.removeItem(PENDING_STORAGE_KEY);
    if (clean !== null) writeStorage(rows);
  }
  cache = rows;
  return cache;
}

function persist(next: PendingEnrollment[]): void {
  const rows = next.map(publicProjection);
  cache = rows;
  writeStorage(rows);
  notify();
}

export function subscribePendingEnrollments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addPendingEnrollment(pending: PendingEnrollment): void {
  persist([
    ...listPendingEnrollments().filter((row) => row.hubEnrollmentId !== pending.hubEnrollmentId),
    pending,
  ]);
}

export function removePendingEnrollment(id: string): void {
  const next = listPendingEnrollments().filter((row) => row.hubEnrollmentId !== id);
  persist(next);
}

export function clearPendingEnrollments(): void {
  persist([]);
}

/** 丢弃已过期的 pending，返回**被丢掉的**那些（UI 据此清掉对应的 join 串展示）。 */
export function prunePendingEnrollments(now: number): PendingEnrollment[] {
  const rows = listPendingEnrollments();
  const alive = rows.filter((row) => row.exp > now);
  if (alive.length === rows.length) return [];
  persist(alive);
  return rows.filter((row) => row.exp <= now);
}

/** 最早的过期时刻；没有 pending 时返回 `null`（用于安排一次性清理定时器）。 */
export function nextPendingExpiry(rows: PendingEnrollment[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    if (min === null || row.exp < min) min = row.exp;
  }
  return min;
}

export function isPendingExpired(pending: PendingEnrollment, now: number): boolean {
  return pending.exp <= now;
}

// ---------------------------------------------------------------------------
// hub 未确认的记录（仅内存）
// ---------------------------------------------------------------------------

/** 已签好、随时可以原样重发的记录（base64url）。 */
export interface SignedRecord {
  bytes: string;
  sig: string;
}

/**
 * `POST /api/auth/keylog?hub=sync` 的失败分类（B2-6 契约）。
 *
 * 服务端在 hub 确认之前**不落库**：hub 明确拒绝 → 409 `{code:<hubError>}`，等 ack 超时 →
 * 504 `{code:'HUB_TIMEOUT'}`，两种情况本地密钥日志都没动。因此：
 *
 * - `unconfirmed`：hub 只是没答应下来（不可达 / 超时）。本地 head 没动，同一份字节仍然接得上，
 *   重试**原样重发**即可。按新 head 重签一个 seq 才是危险的：entry 到了 6、hub 停在 5 时，
 *   重签出来的 7 会让 hub 永久 `seq_gap`（评审 Major 里那条不可恢复的分叉）。
 * - `stale`：这条记录的位置不对（fork / seq_gap）。同一份字节永远不会被接受，必须重新取 head
 *   重签，因此要把暂存的记录丢掉。
 * - `rejected`：记录本身有问题（签名、权限等），重发重签都没用。
 */
export type KeyLogSyncFailure = 'unconfirmed' | 'stale' | 'rejected';

const UNCONFIRMED_CODES = new Set([
  'HUB_TIMEOUT',
  'hub_timeout',
  'timeout',
  'unavailable',
  'hub_unavailable',
  'uplink_down',
]);
const STALE_CODES = new Set(['KEY_LOG_FORK', 'fork', 'seq_gap', 'stale']);

export function classifyKeyLogFailure(code: string): KeyLogSyncFailure {
  if (UNCONFIRMED_CODES.has(code)) return 'unconfirmed';
  if (STALE_CODES.has(code)) return 'stale';
  return 'rejected';
}

export type AdmitDisposition =
  | { kind: 'admitted' }
  | { kind: 'unconfirmed' }
  | { kind: 'stale' }
  | { kind: 'error'; code: string };

/** hub=sync 的响应 → UI 该做什么。页面与测试共用同一份判定。 */
export function admitDisposition(
  result: { ok: true; hubAck?: boolean } | { ok: false; code: string }
): AdmitDisposition {
  if (result.ok) {
    // B2-6 之后 200 不再带 `hubAck:false`；万一遇到（旧版 entry），一律当未确认。
    return result.hubAck === true ? { kind: 'admitted' } : { kind: 'unconfirmed' };
  }
  const failure = classifyKeyLogFailure(result.code);
  if (failure === 'unconfirmed') return { kind: 'unconfirmed' };
  if (failure === 'stale') return { kind: 'stale' };
  return { kind: 'error', code: result.code };
}

/**
 * hub 未确认的 admit 记录。**只在内存里**（记录本身不含秘密，但也没有落盘的必要），
 * 放在模块级而不是组件 state：用户切走再回来仍然要能重发同一份字节。
 */
const unconfirmedRecords = new Map<string, SignedRecord>();
const unconfirmedListeners = new Set<() => void>();
let unconfirmedIds: string[] = [];

function notifyUnconfirmed(): void {
  unconfirmedIds = [...unconfirmedRecords.keys()];
  for (const listener of unconfirmedListeners) listener();
}

export function subscribeUnconfirmedRecords(listener: () => void): () => void {
  unconfirmedListeners.add(listener);
  return () => {
    unconfirmedListeners.delete(listener);
  };
}

/** `useSyncExternalStore` 的快照：引用稳定，只在集合变化时换新数组。 */
export function listUnconfirmedRecordIds(): string[] {
  return unconfirmedIds;
}

export function unconfirmedRecord(pendingId: string): SignedRecord | null {
  return unconfirmedRecords.get(pendingId) ?? null;
}

export function forgetUnconfirmedRecord(pendingId: string): void {
  if (unconfirmedRecords.delete(pendingId)) notifyUnconfirmed();
}

export function clearUnconfirmedRecords(): void {
  if (unconfirmedRecords.size === 0) return;
  unconfirmedRecords.clear();
  notifyUnconfirmed();
}

/**
 * 这条 pending 现在该做什么。
 *
 * **`resend` 永远优先于 `sign`**：只要手上还有一份 hub 未确认的记录，就原样重发它。
 * 轮询每 5 s 会重新看到同一张证书，若那时按新 head 再签一条，就会造出另一个 seq，
 * hub 缺了中间那条便永久 `seq_gap`（评审 Major 里那条不可恢复的分叉）。
 */
export function admitPlan(pendingId: string, canSign: boolean): 'resend' | 'sign' | 'wait' {
  if (unconfirmedRecords.has(pendingId)) return 'resend';
  return canSign ? 'sign' : 'wait';
}

/**
 * 送一条**已签好**的 admit 记录，并按结果决定要不要把它留着重发。
 *
 * 重试路径拿的就是这里存下的对象（`unconfirmedRecord()`），字节完全相同——重试**绝不**重新
 * 取 head、重新签名。
 */
export async function submitAdmitRecord(
  api: {
    appendKeyLog(
      body: SignedRecord,
      opts?: { hubSync?: boolean }
    ): Promise<{ ok: true; hubAck?: boolean } | { ok: false; code: string }>;
  },
  pendingId: string,
  record: SignedRecord
): Promise<AdmitDisposition> {
  const disposition = admitDisposition(await api.appendKeyLog(record, { hubSync: true }));
  if (disposition.kind === 'unconfirmed') {
    unconfirmedRecords.set(pendingId, record);
    notifyUnconfirmed();
  } else {
    // 确认成功、或这条字节已经作废：都不该再留着让用户重发。
    forgetUnconfirmedRecord(pendingId);
  }
  return disposition;
}

// ---------------------------------------------------------------------------
// 证书匹配（唯一的检测入口）
// ---------------------------------------------------------------------------

export type CertificateMatch =
  | { ok: true; nodeIdHex: string; certificateBytes: Uint8Array; certSig: Uint8Array }
  | { ok: false; reason: 'malformed' | 'enroll_pk_mismatch' | 'bad_cert_sig' | 'expired' };

/**
 * 判定一份证书是否属于某条 pending。**唯一**的匹配实现：
 * 无论证书来自轮询（`GET /n/<hub>/api/hub/nodes`）还是将来后端补的 `enroll.redeemed` 推送，
 * 都必须先过这里。
 */
export function matchPendingCertificate(
  pending: PendingEnrollment,
  candidate: CertificateCandidate,
  now: number
): CertificateMatch {
  let certificateBytes: Uint8Array;
  let certSig: Uint8Array;
  let enrollPk: Uint8Array;
  let certificate: ReturnType<typeof decodeCertificate>;
  try {
    certificateBytes = decodeBase64url(candidate.certificate);
    certSig = decodeBase64url(candidate.certSig);
    enrollPk = decodeBase64url(pending.enrollPk);
    certificate = decodeCertificate(certificateBytes);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    certificate.enroll_pk.length !== enrollPk.length ||
    !certificate.enroll_pk.every((byte, index) => byte === enrollPk[index])
  ) {
    return { ok: false, reason: 'enroll_pk_mismatch' };
  }
  if (certSig.length !== 64 || !verifyNodeCertificate(certificateBytes, certSig, enrollPk)) {
    return { ok: false, reason: 'bad_cert_sig' };
  }
  if (isPendingExpired(pending, now)) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    nodeIdHex: bytesToHexLower(certificate.node_id),
    certificateBytes,
    certSig,
  };
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** 在全部 pending 里找出这份证书属于谁；都不匹配返回 `null`（调用方告警「收到未知节点证书」）。 */
export function findPendingForCertificate(
  pendings: PendingEnrollment[],
  candidate: CertificateCandidate,
  now: number
): { pending: PendingEnrollment; match: CertificateMatch } | null {
  for (const pending of pendings) {
    const match = matchPendingCertificate(pending, candidate, now);
    if (match.ok) return { pending, match };
    if (match.reason === 'expired' || match.reason === 'bad_cert_sig') {
      return { pending, match };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 记录构造
// ---------------------------------------------------------------------------

export interface AdmitInput {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  pending: PendingEnrollment;
  certificateBytes: Uint8Array;
  certSig: Uint8Array;
  signer: RecordSigner;
}

/** 构造并签一条 `admit-node`（内嵌 authorization + certificate，其它 node 可独立验证整条链）。 */
export function buildAdmitNodeRecord(input: AdmitInput): Promise<{
  bytes: Uint8Array;
  sig: Uint8Array;
}> {
  const payload = encodeAdmitNodePayload({
    authorization_bytes: decodeBase64url(input.pending.authorizationBytes),
    authorization_sig: decodeBase64url(input.pending.authorizationSig),
    certificate_bytes: new Uint8Array(input.certificateBytes),
    cert_sig: new Uint8Array(input.certSig),
  });
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'admit-node',
    payload,
    signer: input.signer,
  });
}

export interface RevokeInput {
  head: KeyLogHead;
  rootEpoch: number;
  uid: string;
  /** 32 位小写 hex（与 `node_certs.node_id` 一致）。 */
  nodeIdHex: string;
  reason: string;
  signer: RecordSigner;
}

export function buildRevokeNodeRecord(input: RevokeInput): Promise<{
  bytes: Uint8Array;
  sig: Uint8Array;
}> {
  const nodeId = hexToBytes(input.nodeIdHex);
  if (nodeId.length !== 16) {
    return Promise.reject(new Error('node id must be 16 bytes'));
  }
  return buildSignedRecord({
    head: input.head,
    rootEpoch: input.rootEpoch,
    uid: input.uid,
    type: 'revoke-node',
    payload: encodeRevokeNodePayload({ node_id: nodeId, reason: input.reason }),
    signer: input.signer,
  });
}

// ---------------------------------------------------------------------------
// enrollment 创建
// ---------------------------------------------------------------------------

export interface CreateEnrollmentInput {
  hubApi: HubApi;
  uid: string;
  rootEpoch: number;
  /** 授权签名者：根钥或 passkey（`Authorization.signer` 随之为 `root` / `passkey`）。 */
  signer: RecordSigner;
  /**
   * 32 字节根公钥，来自 `GET /api/auth/mode` 的 `rootPublicKey`。
   * join 串第二段是它——passkey 签授权时手上根本没有根钥，只能由服务端下发。
   */
  rootPublicKey: Uint8Array;
  /** `GET /api/auth/keylog/head` 的 head hash（join 串第三段）。 */
  keyLogHeadHash: Uint8Array;
  name?: string | null;
  now?: number;
  ttlMs?: number;
}

/** `/api/auth/mode` 的 `rootPublicKey`：缺失 / 长度不对即协议不兼容，绝不猜。 */
export function requireRootPublicKey(mode: { rootPublicKey?: string | null }): Uint8Array {
  const raw = mode.rootPublicKey;
  if (!raw) throw new ProtocolMismatchError('rootPublicKey');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64url(raw);
  } catch {
    throw new ProtocolMismatchError('rootPublicKey');
  }
  if (bytes.length !== 32) throw new ProtocolMismatchError('rootPublicKey');
  return bytes;
}

/**
 * 创建结果：`pending` 可持久化（全是公开数据），`joinToken` **只在内存**、只显示这一次。
 * `hubPublicUrl` 来自 hub 的 enrollment 创建响应，join 命令只能用它。
 */
export interface CreatedEnrollment {
  pending: PendingEnrollment;
  /** `base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，含私钥，绝不落盘。 */
  joinToken: string;
  hubPublicUrl: string | null;
}

/**
 * 生成一次性 enrollment 密钥对、签授权、送到 hub，并落一条**不含私钥**的 pending。
 *
 * 授权可由根钥签（`authorization_sig` = 64 字节 Ed25519），也可由 passkey 签
 * （`authorization_sig` = Borsh `PasskeyAssertion`，`credential_id` 写在 `Authorization` 里）；
 * 两种都由 hub 的 `handleCreateEnrollment` 与各 node 的 `applyAdmitNode` 独立验证。
 *
 * join 串 = `base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，其中根公钥来自
 * `/api/auth/mode`（passkey 路径下浏览器根本没有根钥）。串一旦拼好，`enroll_sk` 立即清零：
 * 它此后只以字符串形态存在于本次返回值里。
 */
export async function createEnrollmentOnHub(
  input: CreateEnrollmentInput
): Promise<CreatedEnrollment> {
  const now = input.now ?? Date.now();
  if (input.rootPublicKey.length !== 32) {
    throw new Error('root public key must be 32 bytes');
  }
  const enrollment = await createEnrollment(enrollmentSignerFrom(input.signer), {
    uid: input.uid,
    rootEpoch: input.rootEpoch,
    now,
    ttlMs: input.ttlMs,
  });
  // 私钥从**产出的那一刻**起就归这个 try 管：中间任何一步抛异常（编码、hub 请求失败、
  // join 串拼装失败）都不会把 `enroll_sk` 留在堆里。
  try {
    const enrollPk = encodeBase64url(enrollment.enrollPk);
    const authorizationBytes = encodeBase64url(enrollment.authorizationBytes);
    const authorizationSig = encodeBase64url(enrollment.authorizationSig);
    const ttl = input.ttlMs ?? 10 * 60 * 1000;
    const exp = now + ttl;
    const created = await input.hubApi.createEnrollment({
      enroll_pk: enrollPk,
      authorization: authorizationBytes,
      authorization_sig: authorizationSig,
      exp,
    });
    const joinToken = encodeJoinTokenZeroing(
      enrollment.enrollSk,
      input.rootPublicKey,
      input.keyLogHeadHash,
      created.ca_fingerprint
    );
    const pending: PendingEnrollment = {
      hubEnrollmentId: created.id,
      enrollPk,
      authorizationBytes,
      authorizationSig,
      exp: created.expires_at ?? exp,
      name: input.name?.trim() ? input.name.trim() : null,
      createdAt: now,
    };
    addPendingEnrollment(pending);
    return { pending, joinToken, hubPublicUrl: created.public_url ?? null };
  } finally {
    // join 串已经是字符串了，字节副本立刻清零；失败路径同样不留私钥。
    enrollment.enrollSk.fill(0);
  }
}

/**
 * `base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，**并把 96 字节临时缓冲清零**。
 *
 * 没有直接用 `@tmex/shared/auth` 的 `encodeJoinToken()`：它在内部另建一份含 `enroll_sk` 的
 * 96 字节数组且从不清零，调用方够不着那份副本（见 F4-fix 评审 Major）。这里自己拼、自己清，
 * 布局与长度校验与共享实现逐字对齐（`decodeJoinToken()` 是它的反函数）。
 * 共享实现同样应当在 `finally` 里清零——CLI 侧还在用它，需由 `packages/shared` 的负责人处理。
 */
export function encodeJoinTokenZeroing(
  enrollSk: Uint8Array,
  rootPublicKey: Uint8Array,
  keyLogHeadHash: Uint8Array,
  caFingerprint?: string | null,
  /** 仅测试注入：拿到同一块缓冲才能断言它确实被清零。 */
  scratch?: Uint8Array
): string {
  if (enrollSk.length !== 32 || rootPublicKey.length !== 32 || keyLogHeadHash.length !== 32) {
    throw new Error('join token fields must each be 32 bytes');
  }
  const raw = scratch ?? new Uint8Array(JOIN_TOKEN_BYTES);
  if (raw.length !== JOIN_TOKEN_BYTES) {
    throw new Error(`join token buffer must be ${JOIN_TOKEN_BYTES} bytes`);
  }
  try {
    raw.set(enrollSk, 0);
    raw.set(rootPublicKey, 32);
    raw.set(keyLogHeadHash, 64);
    const token = encodeBase64url(raw);
    if (token.length !== JOIN_TOKEN_CHARS) {
      throw new Error(`join token must be ${JOIN_TOKEN_CHARS} chars`);
    }
    if (!caFingerprint) {
      return token;
    }
    const fingerprint = caFingerprint.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error('CA fingerprint must be 64 hex characters');
    }
    return `${token}.${fingerprint}`;
  } finally {
    raw.fill(0);
  }
}

/**
 * hub 对外地址是否可以拼进要让用户粘贴执行的命令。
 *
 * 只认 https（本机回环允许 http，与 secure context 的判定一致），且不带用户名/密码。
 * hub 返回的值不是可信输入：`https://hub.example; touch /tmp/pwn` 这种畸形值一旦拼进命令，
 * 用户粘贴即执行（见 F4-fix 评审 Major）。这里先判 URL 合法，再由 `shellQuote()` 兜底。
 */
export function isTrustedHubUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * 展示给用户的 join 命令。
 * `hubPublicUrl` 必须来自 hub（enrollment 创建响应或 `/api/auth/mode`）：
 * 用当前页面 origin 会让从普通 node entry 发起的 enrollment 把新设备指到没有 HubRuntime
 * 的机器上，redeem 直接 404（见 F4-3 评审 Blocker）。
 *
 * URL 与 token 一律经 `shellQuote()`；URL 还必须先过 `isTrustedHubUrl()`。
 */
export function joinCommand(hubPublicUrl: string, token: string, name?: string | null): string {
  if (!isTrustedHubUrl(hubPublicUrl)) {
    throw new Error('hub public url must be an https url');
  }
  const suffix = name?.trim() ? ` --name ${shellQuote(name.trim())}` : '';
  return `tmex hub join ${shellQuote(hubPublicUrl)} --token ${shellQuote(token)}${suffix}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
