// node 注册（enrollment）与 admit / revoke 的浏览器侧逻辑（设计 §2 步骤 1、3 与「撤销」）。
//
// 关键安全性质：
// - `enroll_sk` **不经过 hub**：只出现在浏览器内存 / sessionStorage 与展示给用户的 join 串里。
// - 只有 `certificate.enroll_pk` 等于本地 pending 的 `enroll_pk`、`cert_sig` 用该 `enroll_pk`
//   验证通过、且 pending 未过期时，才签 `admit-node`。不匹配的证书一律忽略并告警。
// - `sk_sess` 不能签任何记录，admit / revoke 必须当场用根钥（密码）或 passkey。

import type { RecordSigner } from '@/auth';
import { buildSignedRecord } from '@/auth';
import type { KeyLogHead, RootKey } from '@tmex/shared/auth';
import {
  createEnrollment,
  decodeBase64url,
  decodeCertificate,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeJoinToken,
  encodeRevokeNodePayload,
  hexToBytes,
  verifyNodeCertificate,
} from '@tmex/shared/auth';
import type { HubApi } from './hub-api';

export const PENDING_STORAGE_KEY = 'tmex.enrollment.pending';

/** 刚做完密码 / passkey 交互后的免二次输入窗口（设计 §2 步骤 3）。 */
export const SIGNER_REUSE_WINDOW_MS = 5 * 60 * 1000;

/** sessionStorage 里的一条待确认 enrollment。二进制字段一律 base64url。 */
export interface PendingEnrollment {
  /** hub 返回的 enrollment id。 */
  id: string;
  uid: string;
  rootEpoch: number;
  enrollPk: string;
  enrollSk: string;
  authorization: string;
  authorizationSig: string;
  /** 授权过期时间（毫秒）。过期后 pending 不可再 admit。 */
  exp: number;
  /** 展示给用户的 join 串（含 enroll_sk，不进 hub）。 */
  joinToken: string;
  /** 用户给新节点起的名字，拼进 join 命令。 */
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

function isPending(value: unknown): value is PendingEnrollment {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.uid === 'string' &&
    typeof row.enrollPk === 'string' &&
    typeof row.enrollSk === 'string' &&
    typeof row.authorization === 'string' &&
    typeof row.authorizationSig === 'string' &&
    typeof row.exp === 'number' &&
    typeof row.joinToken === 'string'
  );
}

export function listPendingEnrollments(): PendingEnrollment[] {
  if (cache) return cache;
  const store = storage();
  if (!store) {
    cache = [];
    return cache;
  }
  try {
    const raw = store.getItem(PENDING_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function persist(next: PendingEnrollment[]): void {
  cache = next;
  const store = storage();
  if (store) {
    try {
      store.setItem(PENDING_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式下 sessionStorage 会抛；内存态仍然有效，刷新后丢失即可。
    }
  }
  notify();
}

export function subscribePendingEnrollments(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function addPendingEnrollment(pending: PendingEnrollment): void {
  persist([...listPendingEnrollments().filter((row) => row.id !== pending.id), pending]);
}

export function removePendingEnrollment(id: string): void {
  const next = listPendingEnrollments().filter((row) => row.id !== id);
  persist(next);
}

export function clearPendingEnrollments(): void {
  persist([]);
}

/** 丢弃已过期的 pending（UI 每次渲染前调用，避免出现永远确认不了的行）。 */
export function prunePendingEnrollments(now: number): PendingEnrollment[] {
  const rows = listPendingEnrollments();
  const alive = rows.filter((row) => row.exp > now);
  if (alive.length !== rows.length) persist(alive);
  return alive;
}

export function isPendingExpired(pending: PendingEnrollment, now: number): boolean {
  return pending.exp <= now;
}

// ---------------------------------------------------------------------------
// 5 分钟凭据复用（仅内存）
// ---------------------------------------------------------------------------

let rememberedSigner: { signer: RecordSigner; until: number } | null = null;

export function rememberSigner(signer: RecordSigner, now: number): void {
  rememberedSigner = { signer, until: now + SIGNER_REUSE_WINDOW_MS };
}

export function takeRememberedSigner(now: number): RecordSigner | null {
  if (!rememberedSigner) return null;
  if (rememberedSigner.until <= now) {
    rememberedSigner = null;
    return null;
  }
  return rememberedSigner.signer;
}

export function forgetSigner(): void {
  rememberedSigner = null;
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
    authorization_bytes: decodeBase64url(input.pending.authorization),
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
  /** 根钥：join 串需要 `root_public_key`，因此**必须**能拿到根公钥。 */
  rootKey: RootKey;
  /** `GET /api/auth/keylog/head` 的 head hash（join 串第三段）。 */
  keyLogHeadHash: Uint8Array;
  name?: string | null;
  now?: number;
  ttlMs?: number;
}

/**
 * 生成一次性 enrollment 密钥对、签授权、送到 hub，并落一条 pending。
 *
 * join 串 = `base64url(enroll_sk ‖ root_public_key ‖ key_log_head_hash)`，因此**只有根钥路径**
 * 能生成完整 join 串：passkey 签授权时浏览器没有根公钥（`/api/auth/mode` 未下发）。
 * 见结果文档「后端待补」。
 */
export async function createEnrollmentOnHub(
  input: CreateEnrollmentInput
): Promise<PendingEnrollment> {
  const now = input.now ?? Date.now();
  const enrollment = await createEnrollment(input.rootKey, {
    uid: input.uid,
    rootEpoch: input.rootEpoch,
    now,
    ttlMs: input.ttlMs,
  });
  const enrollPk = encodeBase64url(enrollment.enrollPk);
  const authorization = encodeBase64url(enrollment.authorizationBytes);
  const authorizationSig = encodeBase64url(enrollment.authorizationSig);
  const ttl = input.ttlMs ?? 10 * 60 * 1000;
  const exp = now + ttl;
  const created = await input.hubApi.createEnrollment({
    enroll_pk: enrollPk,
    authorization,
    authorization_sig: authorizationSig,
    exp,
  });
  const joinToken = encodeJoinToken(
    enrollment.enrollSk,
    input.rootKey.publicKey,
    input.keyLogHeadHash
  );
  const pending: PendingEnrollment = {
    id: created.id,
    uid: input.uid,
    rootEpoch: input.rootEpoch,
    enrollPk,
    enrollSk: encodeBase64url(enrollment.enrollSk),
    authorization,
    authorizationSig,
    exp: created.expires_at ?? exp,
    joinToken,
    name: input.name?.trim() ? input.name.trim() : null,
    createdAt: now,
  };
  addPendingEnrollment(pending);
  return pending;
}

/** 展示给用户的 join 命令。 */
export function joinCommand(hubPublicUrl: string, token: string, name?: string | null): string {
  const suffix = name?.trim() ? ` --name ${shellQuote(name.trim())}` : '';
  return `npx tmex-cli hub join ${hubPublicUrl} --token ${token}${suffix}`;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
