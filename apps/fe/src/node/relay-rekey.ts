// 吊销之后刷新令牌：被吊销的节点手里还有当前租户令牌，中继侧在那次吊销之后签发的令牌才不认它。
// 令牌只能由持根钥的一方经中继接入流程换发，再用 `set-relays` 送给剩余成员——
// 因此这里对每条已配置的中继重走一遍既有的接入（enroll proof → `enroll` → `set-relays`），
// 并带 `force_rotate`：中继不能靠推断（passkey 吊销、从未连过的节点它都看不到吊销）决定沿用旧令牌。
// enroll 响应没有「沿用 / 换发」标志，所以成功只表示已提交，不断言令牌确实变了。

import type { RecordSigner } from '@/auth/key-log-actions';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { isRelayRoutesMissing } from '@vibeterm/api-client/relay/tenant-api';
import type { RelayFlowDeps } from './relay-enroll';
import { enrollWithRootKey, relayFlowFailure } from './relay-enroll';

/** 签名者不是根钥（通行密钥签不出 enroll proof），或用户没给出根密码。 */
export const RELAY_REKEY_NEEDS_ROOT = 'RELAY_REKEY_NEEDS_ROOT';

export type RelayRekeyResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      /** 还没刷新的中继地址；空表示没能读到中继列表，重试时按全部处理。 */
      urls: string[];
    };

function failureCode(err: unknown): string {
  const failure = relayFlowFailure(err);
  return failure.ok ? 'UNKNOWN' : failure.code;
}

async function storedEnrollPassword(api: RelayTenantApi, url: string): Promise<string | null> {
  try {
    return (await api.enrollPassword(url)).password;
  } catch {
    return null;
  }
}

/**
 * 刷新全部已配置中继（或 `only` 指定的那几条）的租户令牌。非中继模式、旧节点没有中继路由时无事可做。
 * 单条失败不拦后面几条；失败的地址原样带回，供重试。
 */
export async function rekeyRelays(
  deps: RelayFlowDeps,
  signer: RecordSigner,
  only?: string[]
): Promise<RelayRekeyResult> {
  let configured: string[];
  try {
    const status = await deps.relayApi.status();
    configured = status.mode === 'relay' ? status.relays.map((row) => row.url) : [];
  } catch (err) {
    if (isRelayRoutesMissing(err)) return { ok: true };
    return { ok: false, code: failureCode(err), urls: only ?? [] };
  }
  const urls = only ? configured.filter((url) => only.includes(url)) : configured;
  if (urls.length === 0) return { ok: true };
  if (signer.kind !== 'root') return { ok: false, code: RELAY_REKEY_NEEDS_ROOT, urls };

  const failed: string[] = [];
  let code = '';
  for (const url of urls) {
    const password = await storedEnrollPassword(deps.relayApi, url);
    const result = await enrollWithRootKey(
      deps,
      { url, password, forceRotate: true },
      signer.rootKey
    ).catch((err: unknown) => ({ ok: false as const, code: failureCode(err) }));
    if (result.ok) continue;
    failed.push(url);
    code ||= result.code;
  }
  return failed.length > 0 ? { ok: false, code, urls: failed } : { ok: true };
}
