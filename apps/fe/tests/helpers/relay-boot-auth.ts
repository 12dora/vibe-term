// relay-boot 的鉴权 / 密钥日志助手：与浏览器同一条密码登录链路（Argon2 seed → Ed25519 root →
// delegation → challenge/login），外加中继模式下「加节点向导」的两步——生成 r3 加入码、
// 兑换之后补签 admit-node 与 meta-key。CLI 没有这两条命令（`vibeterm enroll` 只走 hub 路径），
// 所以这里按 apps/fe/src/node/relay-join.ts 与 apps/gateway/src/relay/integration/relay-tenant-ops.ts
// 复刻同一套 shared 助手调用，全部走真实 HTTP 接口。
//
// 只服务于 relay-boot.ts；spec 里的登录仍然走真实 UI。

import {
  type RootKey,
  buildKeyLogRecord,
  buildLogin,
  createDelegation,
  createEnrollment,
  decodeBase64url,
  deriveSeed,
  encodeAdmitNodePayload,
  encodeBase64url,
  encodeKeyLogRecord,
  encodeLogin,
  generateEd25519KeyPair,
  rootKeyFromSeed,
  signKeyLogRecordWithRoot,
  signLogin,
} from '../../../../packages/shared/src/auth/index.ts';
import { encodeRelayJoinToken } from '../../../../packages/shared/src/relay/index.ts';

export interface AuthMode {
  nodeId: string;
  uid: string;
  kdfParams: { salt: string; memory_kib: number; iterations: number; parallelism: number };
}

export interface Session {
  baseUrl: string;
  uid: string;
  /** 入口节点编号（`/api/auth/mode.nodeId`）：远端 node 的 login 必须绑定它。 */
  entryNodeId: string;
  rootKey: RootKey;
  cookies: Record<string, string>;
  sessSecretKey: Uint8Array;
  delegationBytes: Uint8Array;
  delegationSig: Uint8Array;
}

export interface KeyLogHead {
  seq: bigint;
  hash: Uint8Array;
  rootEpoch: number;
}

/** 一次尚未被承认的 r3 加入：token 交给新机器，其余字段留着补签 admit-node。 */
export interface PendingRelayJoin {
  token: string;
  enrollmentId: string;
  authorizationBytes: Uint8Array;
  authorizationSig: Uint8Array;
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function collectCookies(target: Record<string, string>, res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) target[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
}

async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) throw new Error(`${label} failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function apiGet<T>(session: Session, path: string, label: string): Promise<T> {
  return await readJson<T>(
    await fetch(`${session.baseUrl}${path}`, {
      headers: { cookie: cookieHeader(session.cookies) },
    }),
    label
  );
}

export async function apiPost<T>(
  session: Session,
  path: string,
  body: unknown,
  label: string
): Promise<T> {
  const res = await fetch(`${session.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(session.cookies) },
    body: JSON.stringify(body),
  });
  return await readJson<T>(res, label);
}

/** 密码 → 根钥：与前端 `deriveSeed` 同参数，派生出的根钥可直接签密钥日志记录。 */
export async function deriveRootKey(
  baseUrl: string,
  password: string
): Promise<{
  mode: AuthMode;
  rootKey: RootKey;
}> {
  const mode = await readJson<AuthMode>(await fetch(`${baseUrl}/api/auth/mode`), 'auth mode');
  const seed = await deriveSeed(password, {
    salt: decodeBase64url(mode.kdfParams.salt),
    memory_kib: mode.kdfParams.memory_kib,
    iterations: mode.kdfParams.iterations,
    parallelism: mode.kdfParams.parallelism,
  });
  return { mode, rootKey: rootKeyFromSeed(seed) };
}

/** 登录一台 node：`self` 走本机路径，其余走入口机上的 `/n/<id>` 前缀（与前端一致）。 */
export async function loginNode(session: Session, target: string): Promise<void> {
  const prefix = target === 'self' ? '' : `/n/${target}`;
  const challenge = await readJson<{ challenge_id: string; nonce: string; nodePk: string }>(
    await fetch(`${session.baseUrl}${prefix}/api/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(session.cookies) },
      body: JSON.stringify({ uid: session.uid }),
    }),
    `challenge ${target}`
  );
  const login = buildLogin({
    challengeId: challenge.challenge_id,
    nonce: decodeBase64url(challenge.nonce),
    target,
    targetPk: decodeBase64url(challenge.nodePk),
    uid: session.uid,
    entry: target === 'self' ? 'self' : session.entryNodeId,
  });
  const res = await fetch(`${session.baseUrl}${prefix}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader(session.cookies) },
    body: JSON.stringify({
      login: encodeBase64url(encodeLogin(login)),
      sig: encodeBase64url(signLogin(session.sessSecretKey, login)),
      delegation: encodeBase64url(session.delegationBytes),
      delegation_sig: encodeBase64url(session.delegationSig),
    }),
  });
  if (!res.ok) throw new Error(`login ${target} failed ${res.status}: ${await res.text()}`);
  collectCookies(session.cookies, res);
}

export async function openSession(baseUrl: string, password: string): Promise<Session> {
  const { mode, rootKey } = await deriveRootKey(baseUrl, password);
  const sess = generateEd25519KeyPair();
  const delegation = createDelegation(rootKey, {
    uid: mode.uid,
    sessPk: sess.publicKey,
    now: Date.now(),
  });
  const session: Session = {
    baseUrl,
    uid: mode.uid,
    entryNodeId: mode.nodeId,
    rootKey,
    cookies: {},
    sessSecretKey: sess.secretKey,
    delegationBytes: delegation.bytes,
    delegationSig: delegation.sig,
  };
  await loginNode(session, 'self');
  return session;
}

export async function keyLogHead(session: Session): Promise<KeyLogHead> {
  const head = await apiGet<{ seq: number | string; hash: string; rootEpoch: number }>(
    session,
    '/api/auth/keylog/head',
    'keylog head'
  );
  return {
    seq: BigInt(head.seq),
    hash: decodeBase64url(head.hash),
    rootEpoch: head.rootEpoch,
  };
}

/** 待签 payload → 根钥签名 → `POST /api/auth/keylog?hub=sync`（与 CLI / 前端同一条路径）。 */
export async function submitKeyLogRecord(
  session: Session,
  type: 'set-relays' | 'meta-key' | 'admit-node',
  payload: Uint8Array
): Promise<void> {
  const head = await keyLogHead(session);
  const record = buildKeyLogRecord({ seq: head.seq, hash: head.hash }, head.rootEpoch, {
    uid: session.uid,
    type,
    payload,
    signer: 'root',
    credential_id: null,
  });
  const bytes = encodeKeyLogRecord(record);
  await apiPost(
    session,
    '/api/auth/keylog?hub=sync',
    {
      bytes: encodeBase64url(bytes),
      sig: encodeBase64url(signKeyLogRecordWithRoot(session.rootKey, bytes)),
    },
    `keylog ${type}`
  );
}

interface JoinMaterial {
  logKey: string;
  relays: Array<{ url: string; tenantId: string; token: string }>;
}

interface EnrollmentCreated {
  id: string;
  relays?: Array<{ url: string; tenantId: string; token?: string; accepted: boolean }>;
}

/** fan-out 结果里只有真的收下 enrollment 的中继能进 join 串，否则新机器会在那台上撞 404。 */
function acceptedRelays(
  material: JoinMaterial,
  created: EnrollmentCreated
): Array<{ url: string; tenantId: string; token: Uint8Array }> {
  const rows = created.relays?.filter((row) => row.accepted) ?? [];
  const targets =
    rows.length > 0 ? rows : material.relays.map((row) => ({ ...row, accepted: true }));
  const usable = targets
    .map((row) => ({
      url: row.url,
      tenantId: row.tenantId,
      token: row.token ?? material.relays.find((item) => item.url === row.url)?.token ?? '',
    }))
    .filter((row) => row.token !== '');
  if (usable.length === 0) throw new Error('no relay accepted the enrollment');
  return usable.map((row) => ({
    url: row.url,
    tenantId: row.tenantId,
    token: decodeBase64url(row.token),
  }));
}

/** 复刻加节点向导：建 enrollment → fan-out 到中继 → 拼 `r3.` 加入码。 */
export async function mintRelayJoinToken(session: Session): Promise<PendingRelayJoin> {
  const material = await apiGet<JoinMaterial>(
    session,
    '/api/mesh/relay/join-material',
    'join material'
  );
  const head = await keyLogHead(session);
  const now = Date.now();
  const ttlMs = 600_000;
  const enrollment = await createEnrollment(session.rootKey, {
    uid: session.uid,
    rootEpoch: head.rootEpoch,
    now,
    ttlMs,
  });
  const created = await apiPost<EnrollmentCreated>(
    session,
    '/api/mesh/relay/enrollments',
    {
      enroll_pk: encodeBase64url(enrollment.enrollPk),
      authorization: encodeBase64url(enrollment.authorizationBytes),
      authorization_sig: encodeBase64url(enrollment.authorizationSig),
      exp: now + ttlMs,
    },
    'relay enrollments'
  );
  const token = encodeRelayJoinToken({
    enrollSk: enrollment.enrollSk,
    rootPublicKey: session.rootKey.publicKey,
    keyLogHeadHash: head.hash,
    logKey: decodeBase64url(material.logKey),
    relays: acceptedRelays(material, created),
  });
  return {
    token,
    enrollmentId: created.id,
    authorizationBytes: enrollment.authorizationBytes,
    authorizationSig: enrollment.authorizationSig,
  };
}

interface EnrollmentRow {
  status: 'pending' | 'redeemed';
  nodeId?: string;
  certificate?: string;
  cert_sig?: string;
}

async function waitRedeemed(
  session: Session,
  enrollmentId: string,
  timeoutMs: number
): Promise<EnrollmentRow> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const row = await apiGet<EnrollmentRow>(
        session,
        `/api/mesh/relay/enrollments/${enrollmentId}`,
        'enrollment'
      );
      if (row.status === 'redeemed' && row.certificate && row.cert_sig && row.nodeId) return row;
      last = JSON.stringify(row);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`enrollment ${enrollmentId} was never redeemed: ${last}`);
}

/**
 * 兑换之后由租户主节点承认：admit-node，再补一条换代 `meta-key`（新成员才拿得到 K_meta）。
 * 与前端加节点向导、`relay-tenant-ops.admitRedeemed` 同序。
 */
export async function admitRelayNode(
  session: Session,
  pending: PendingRelayJoin,
  timeoutMs = 60_000
): Promise<string> {
  const row = await waitRedeemed(session, pending.enrollmentId, timeoutMs);
  const nodeId = row.nodeId as string;
  await submitKeyLogRecord(
    session,
    'admit-node',
    encodeAdmitNodePayload({
      authorization_bytes: pending.authorizationBytes,
      authorization_sig: pending.authorizationSig,
      certificate_bytes: decodeBase64url(row.certificate as string),
      cert_sig: decodeBase64url(row.cert_sig as string),
    })
  );
  const prepared = await apiPost<{ payload: string }>(
    session,
    '/api/mesh/relay/meta-key/prepare',
    { op: 'admit', node_id: nodeId },
    'meta-key prepare'
  );
  await submitKeyLogRecord(session, 'meta-key', decodeBase64url(prepared.payload));
  return nodeId;
}
