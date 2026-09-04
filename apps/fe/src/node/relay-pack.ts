// 中继密封包（sealed pack）的浏览器侧刷新（docs/relay/2026090304-relay-role.md §5b）。
//
// 密封包是「中继地址 + 租户编号 + 账户密码」加入的唯一凭据：它把 `K_log`、租户令牌与当时的
// 密钥日志头钉在一块只有根种子能解开的密文里（`KEK = HKDF(root_seed, tenant_id)`）。
// 节点自己**造不出**它——根种子从不落到节点上——所以每当浏览器现场派生出根钥（接入中继、
// 改密、根签一条记录）时都要顺手重封一次，否则密封包会停在旧的日志头甚至旧的 root_epoch。
//
// 失败一律不影响调用方的主流程：接入 / 改密本身已经成功，密封包只是「别的机器能不能用密码
// 加入」这一件事的凭据，欠着可以后补（见 `relay-meta-key-pending.ts` 的欠账机制）。

import { kdfParamsFromJson } from '@/auth/key-log-actions';
import type { RecordSigner } from '@/auth/key-log-actions';
import type { AuthApi, AuthKdfParamsJson } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import type {
  RelayJoinMaterialRelay,
  RelayPackEntry,
  RelayTenantApi,
} from '@tmex/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@tmex/api-client/relay/tenant-api';
import { decodeBase64url, encodeBase64url, rootKeyFromSeed } from '@tmex/shared/auth';
import { kdfParamsToWire, sealRelayPack } from '@tmex/shared/relay';
import { getMeshRelayState, isRelayMode } from './mesh-relay';
import { forgetRelayPackDebt } from './relay-meta-key-pending';

export interface RefreshRelayPackInput {
  /** 32 字节根种子；本模块只读不清零，清零仍由持有方负责。 */
  rootSeed: Uint8Array;
  api?: AuthApi;
  relayApi?: RelayTenantApi;
  /** 只封给这几台中继；省略即 join-material 给出的全部中继。 */
  urls?: string[];
  /** 与 `rootSeed` 配套的 kdf 参数；省略则问 `/api/auth/mode`（改密时必须显式给新参数）。 */
  kdfParams?: AuthKdfParamsJson;
  /** 密封包要绑定的 root_epoch；省略则取密钥日志头上的当前值。 */
  rootEpoch?: number;
}

function headSeqToWire(seq: number | string): number | string {
  const value = typeof seq === 'number' ? seq : Number(seq);
  return Number.isSafeInteger(value) ? value : String(seq);
}

async function resolveKdfParams(
  api: AuthApi,
  given?: AuthKdfParamsJson
): Promise<AuthKdfParamsJson> {
  if (given) return given;
  const mode = await api.getMode();
  if (!mode.kdfParams) throw new Error('auth mode has no kdf params');
  return mode.kdfParams;
}

function rootPublicKeyFromSeed(rootSeed: Uint8Array): Uint8Array {
  const rootKey = rootKeyFromSeed(rootSeed);
  // `rootKeyFromSeed` 自己复制了一份种子，用完必须抹掉，否则堆里多留一份根私钥。
  try {
    return rootKey.publicKey;
  } finally {
    rootKey.seed.fill(0);
  }
}

/**
 * 一台中继一块密封包。
 *
 * 租户编号与令牌都是**每台中继各自签发**的：KEK 的 info 是那台的 tenant_id、明文里钉的是那台
 * 的令牌、AAD 也绑那台，一块密封包换个中继既解不开也没用。所以这里逐台密封，一次提交。
 */
async function sealPacksFor(input: {
  rootSeed: Uint8Array;
  rootPublicKey: Uint8Array;
  rootEpoch: number;
  relays: RelayJoinMaterialRelay[];
  logKeyB64: string;
  head: { seq: bigint; hash: Uint8Array };
}): Promise<RelayPackEntry[]> {
  const packs: RelayPackEntry[] = [];
  const issuedAt = BigInt(Date.now());
  for (const relay of input.relays) {
    const logKey = decodeBase64url(input.logKeyB64);
    const token = decodeBase64url(relay.token);
    let sealed: Uint8Array;
    try {
      sealed = await sealRelayPack({
        rootSeed: input.rootSeed,
        tenantId: relay.tenantId,
        rootPublicKey: input.rootPublicKey,
        rootEpoch: input.rootEpoch,
        plaintext: {
          log_key: logKey,
          token,
          head_seq: input.head.seq,
          head_hash: input.head.hash,
          issued_at: issuedAt,
        },
      });
    } finally {
      logKey.fill(0);
      token.fill(0);
    }
    try {
      packs.push({ url: relay.url, sealed_pack: encodeBase64url(sealed) });
    } finally {
      sealed.fill(0);
    }
  }
  return packs;
}

async function sealAndUpload(input: RefreshRelayPackInput): Promise<void> {
  const api = input.api ?? defaultAuthApi;
  const relayApi = input.relayApi ?? defaultRelayTenantApi;
  const material = await relayApi.joinMaterial();
  const wanted = input.urls && input.urls.length > 0 ? new Set(input.urls) : null;
  const relays = wanted ? material.relays.filter((row) => wanted.has(row.url)) : material.relays;
  if (relays.length === 0) throw new Error('relay join material has no matching relay');
  const head = await api.keyLogHead();
  const kdfParams = await resolveKdfParams(api, input.kdfParams);
  const rootEpoch = input.rootEpoch ?? head.rootEpoch;
  const packs = await sealPacksFor({
    rootSeed: input.rootSeed,
    rootPublicKey: rootPublicKeyFromSeed(input.rootSeed),
    rootEpoch,
    relays,
    logKeyB64: material.logKey,
    head: { seq: BigInt(head.seq), hash: decodeBase64url(head.hash) },
  });
  await relayApi.uploadPack({
    packs,
    kdf_params: kdfParamsToWire(kdfParamsFromJson(kdfParams)),
    root_epoch: rootEpoch,
    head_seq: headSeqToWire(head.seq),
  });
}

/**
 * 取材料 → 密封 → `POST /api/mesh/relay/pack`。成功返回 `true`，失败只记日志返回 `false`。
 * 调用方据此决定要不要提示或记一笔欠账；**不抛异常**，主流程不因它失败。
 */
export async function refreshRelayPack(input: RefreshRelayPackInput): Promise<boolean> {
  try {
    await sealAndUpload(input);
    return true;
  } catch (error) {
    console.warn('[relay] sealed pack refresh failed', error);
    return false;
  }
}

/** `refreshRelayPackForSigner` 的结论：跳过 / 已刷新 / 刷失败。 */
export type RelayPackRefreshOutcome = 'skipped' | 'refreshed' | 'failed';

/** 同一把根钥只刷一次：手动重试与 `withSigner` 钩子会先后拿到同一个签名者。 */
const refreshedRootKeys = new WeakSet<object>();

/**
 * 根签名者用完之后顺手刷一次密封包（`withSigner` 的统一钩子）。
 *
 * 只认根钥：KEK 由根种子派生，通行密钥断言给不出种子，因此 passkey 签的记录一律跳过——
 * 密封包停在上一次的日志头，加入方仍能验过并追上后续记录（与 `r3.` 加入码同一档保证）。
 * 只在中继模式下动手；hub 模式没有密封包这回事。
 */
export async function refreshRelayPackForSigner(
  signer: RecordSigner,
  options: { api?: AuthApi; relayApi?: RelayTenantApi } = {}
): Promise<RelayPackRefreshOutcome> {
  if (signer.kind !== 'root') return 'skipped';
  if (!isRelayMode(getMeshRelayState())) return 'skipped';
  if (refreshedRootKeys.has(signer.rootKey)) return 'skipped';
  refreshedRootKeys.add(signer.rootKey);
  const ok = await refreshRelayPack({ rootSeed: signer.rootKey.seed, ...options });
  // 刷成功即销账；刷失败不新记一笔——一次网络抖动不该在页面上挂一条常驻告警，
  // 真正让密封包作废的只有根轮换（那一路显式记账）。
  if (ok) forgetRelayPackDebt();
  return ok ? 'refreshed' : 'failed';
}
