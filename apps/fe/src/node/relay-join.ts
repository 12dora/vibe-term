// 中继模式下的「加入码」：join 串 v3（`r3.`）与它的 enrollment 创建（plan-00 §1.5、§1.9）。
//
// 与 hub 模式的差别只有两处：enrollment 建在中继上（经本机 uplink 转发），join 串里除了
// `enroll_sk ‖ root_pk ‖ head_hash` 还带上 `K_log` 与中继表（每条自带 `tenant_id ‖ token`）——
// 新节点没有 hub 可问，必须自带解密密钥日志与连中继的全部材料。
//
// join 串里的中继表**只列真的收下了这条 enrollment 的那几台**：节点侧会把 enrollment fan-out
// 到全部已授权中继，部分失败是常态，把没接受的写进去只会让新机器在那台上撞 404。
// 完整的有序中继表由加入后下载的 `set-relays` 记录送达。
//
// `enroll_sk` 与 `K_log` 都**只**出现在内存与展示给用户的 join 串里：落盘的 pending 只有公开字段
// （见 `enrollment.ts` 的 `PendingEnrollment`），字节缓冲用完立刻清零。

import type { RecordSigner } from '@/auth/key-log-actions';
import { enrollmentSignerFrom } from '@/auth/key-log-actions';
import type { RelayJoinMaterial, RelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { createEnrollment, decodeBase64url, encodeBase64url } from '@tmex/shared/auth';
import { encodeRelayJoinToken } from '@tmex/shared/relay';
import type { CreatedEnrollment, PendingEnrollment } from './enrollment';
import { addPendingEnrollment } from './enrollment';
import type { EnrollmentRelayResult, HubApi } from './hub-api';

/** 建好的 enrollment 一台中继都没收下：加入码发不出去，界面按这个码给提示。 */
export const RELAY_ENROLLMENT_NO_RELAY = 'RELAY_ENROLLMENT_NO_RELAY';

/**
 * 网关侧同一件事的错误码：fan-out 一台都没接受时 `POST /api/mesh/relay/enrollments` 直接
 * 502 `RELAY_ENROLL_FANOUT_FAILED`（见 `apps/gateway/src/mesh/relay-routes.ts`），
 * 因此 `createEnrollmentOnRelay` 根本走不到下面那条本地判定。界面对两者给同一句提示。
 */
export const RELAY_ENROLL_FANOUT_FAILED = 'RELAY_ENROLL_FANOUT_FAILED';

export interface CreateRelayEnrollmentInput {
  /** enrollment 通道：中继模式下是 `RelayEnrollmentApi`（路径指向 `/api/mesh/relay/*`）。 */
  channel: HubApi;
  /** 中继控制面：join 串材料（`K_log` / 租户令牌 / 地址表）从这里取。 */
  relayApi: RelayTenantApi;
  uid: string;
  rootEpoch: number;
  signer: RecordSigner;
  /** 32 字节根公钥（`/api/auth/mode`）。 */
  rootPublicKey: Uint8Array;
  /** `GET /api/auth/keylog/head` 的 head hash。 */
  keyLogHeadHash: Uint8Array;
  name?: string | null;
  now?: number;
  ttlMs?: number;
}

/**
 * 生成一次性 enrollment 密钥对、签授权、在中继上建 enrollment，并落一条**不含私钥**的 pending。
 *
 * join 串按 §1.5 的 `r3.` 布局拼；`enroll_sk`、`K_log` 与租户令牌的字节副本在 `finally` 里清零
 * （`encodeRelayJoinToken` 只负责清它自己那份编码缓冲）。
 */
export async function createEnrollmentOnRelay(
  input: CreateRelayEnrollmentInput
): Promise<CreatedEnrollment> {
  const now = input.now ?? Date.now();
  if (input.rootPublicKey.length !== 32) {
    throw new Error('root public key must be 32 bytes');
  }
  const material = await input.relayApi.joinMaterial();
  if (material.relays.length === 0) {
    throw new Error('relay list is empty');
  }
  const logKey = decodeBase64url(material.logKey);
  const enrollment = await createEnrollment(enrollmentSignerFrom(input.signer), {
    uid: input.uid,
    rootEpoch: input.rootEpoch,
    now,
    ttlMs: input.ttlMs,
  });
  let relays: Array<{ url: string; tenantId: string; token: Uint8Array }> = [];
  try {
    const enrollPk = encodeBase64url(enrollment.enrollPk);
    const authorizationBytes = encodeBase64url(enrollment.authorizationBytes);
    const authorizationSig = encodeBase64url(enrollment.authorizationSig);
    const ttl = input.ttlMs ?? 10 * 60 * 1000;
    const exp = now + ttl;
    const created = await input.channel.createEnrollment({
      enroll_pk: enrollPk,
      authorization: authorizationBytes,
      authorization_sig: authorizationSig,
      exp,
    });
    const accepted = await acceptedRelays(input.relayApi, material, created.relays);
    relays = accepted.map((relay) => ({
      url: relay.url,
      tenantId: relay.tenantId,
      token: decodeBase64url(relay.token),
    }));
    const joinToken = encodeRelayJoinToken({
      enrollSk: enrollment.enrollSk,
      rootPublicKey: input.rootPublicKey,
      keyLogHeadHash: input.keyLogHeadHash,
      logKey,
      relays,
    });
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
    return { pending, joinToken, hubPublicUrl: relays[0].url };
  } finally {
    enrollment.enrollSk.fill(0);
    logKey.fill(0);
    for (const relay of relays) relay.token.fill(0);
  }
}

/** 一台中继在 join 串里需要的全部材料（令牌仍是 base64url，最后一步才解成字节）。 */
interface RelayTarget {
  url: string;
  tenantId: string;
  token: string;
}

/**
 * enrollment 建成之后，哪几台中继真的收下了它。
 *
 * 新节点返回逐台结果（fan-out 会有部分失败）：只有 `accepted` 的那几台能 redeem，把没接受的
 * 写进 join 串只会让新机器在那台上撞 404 并中断整轮尝试。
 * 旧节点根本不下发 `relays`：维持原样，join 串只带当前 attach 的那一台。
 */
async function acceptedRelays(
  relayApi: RelayTenantApi,
  material: RelayJoinMaterial,
  wire: string[] | EnrollmentRelayResult[] | undefined
): Promise<RelayTarget[]> {
  if (!wire || wire.length === 0) return material.relays;
  if (typeof wire[0] === 'string') {
    return await targetsByUrl(relayApi, material, wire as string[]);
  }
  const rows = (wire as EnrollmentRelayResult[]).filter((row) => row.accepted);
  if (rows.length === 0) throw noRelayAccepted(wire as EnrollmentRelayResult[]);
  const targets = rows.map((row) => ({
    url: row.url,
    tenantId: row.tenantId,
    token: row.token ?? tokenOf(material, row.url),
  }));
  const usable = targets.filter((target): target is RelayTarget => Boolean(target.token));
  if (usable.length === 0) throw noRelayAccepted(wire as EnrollmentRelayResult[]);
  return usable;
}

/**
 * 旧形态（只有地址表）：一律当作全部接受，凭据按地址回查。attach 的那一台以外的令牌只在
 * `scope=all` 里，故只有地址表超出手头这一份时才多问一次。
 */
async function targetsByUrl(
  relayApi: RelayTenantApi,
  material: RelayJoinMaterial,
  urls: string[]
): Promise<RelayTarget[]> {
  const known = new Set(material.relays.map((relay) => relay.url));
  const full = urls.every((url) => known.has(url))
    ? material
    : await relayApi.joinMaterial({ scope: 'all' });
  const targets = urls
    .map((url) => full.relays.find((relay) => relay.url === url))
    .filter((relay): relay is RelayTarget => relay !== undefined);
  if (targets.length === 0) throw new Error('relay list is empty');
  return targets;
}

function tokenOf(material: RelayJoinMaterial, url: string): string {
  return material.relays.find((relay) => relay.url === url)?.token ?? '';
}

/** 一台都没接受：把逐台原因带上去，界面才说得出「哪台、为什么」。 */
function noRelayAccepted(rows: EnrollmentRelayResult[]): Error {
  const detail = rows.map((row) => `${row.url}: ${row.error ?? 'rejected'}`).join('; ');
  const error = new Error(`no relay accepted the enrollment (${detail})`);
  (error as Error & { code: string }).code = RELAY_ENROLLMENT_NO_RELAY;
  return error;
}
