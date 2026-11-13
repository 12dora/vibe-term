// 吊销落账之后刷新中继令牌：吊销、批量移除、远程卸载共用这一段。
//
// 签名者沿用吊销时那一把（根钥路径在同一个 `withSigner` 回调里直接接着做，不再提示）；
// 通行密钥签不出 enroll proof，回调结束后补一次凭据框。刷新失败不回滚吊销，只给一行错误与重试。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import type { RecordSigner } from '@/auth/key-log-actions';
import { withKeyLogLock } from '@/node/enrollment-engine';
import type { RelayFlowDeps } from '@/node/relay-enroll';
import type { RelayRekeyResult } from '@/node/relay-rekey';
import { RELAY_REKEY_NEEDS_ROOT, rekeyRelays } from '@/node/relay-rekey';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { RelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { defaultRelayTenantApi } from '@vibeterm/api-client/relay/tenant-api';
import { toast } from 'sonner';
import { relayErrorText } from '../relay/use-relay-actions';
import type { ResolvedMode } from './types';

export interface RekeyDeps {
  api: AuthApi;
  mode: ResolvedMode;
  t: (key: string, options?: Record<string, unknown>) => string;
  prompt: Pick<CredentialPromptHandle, 'withSigner'>;
  /** 测试注入；缺省打本机 `/api/mesh/relay/*`。 */
  relayApi?: RelayTenantApi;
}

function flowDepsOf(deps: RekeyDeps): RelayFlowDeps {
  return {
    api: deps.api,
    relayApi: deps.relayApi ?? defaultRelayTenantApi,
    mode: deps.mode,
    lock: withKeyLogLock,
  };
}

/**
 * 在 `withSigner` 回调里调用：先跑吊销，有节点落账就紧接着用同一把签名者刷新中继令牌。
 * 批量路径整批只刷新一次（全部吊销完之后）。
 */
export async function revokeAndRekey<T>(
  deps: RekeyDeps,
  signer: RecordSigner,
  revoke: () => Promise<{ value: T; landed: boolean }>
): Promise<{ value: T; rekey: RelayRekeyResult | null }> {
  const { value, landed } = await revoke();
  return { value, rekey: landed ? await rekeyRelays(flowDepsOf(deps), signer) : null };
}

/** 回调结束之后落提示：通行密钥签的吊销补一次凭据，其余失败给一行错误和重试。 */
export async function reportRekey(deps: RekeyDeps, result: RelayRekeyResult | null): Promise<void> {
  if (!result || result.ok) return;
  if (result.code === RELAY_REKEY_NEEDS_ROOT) {
    await retryRekey(deps, result.urls);
    return;
  }
  announceFailure(deps, result);
}

async function retryRekey(deps: RekeyDeps, urls: string[]): Promise<void> {
  const only = urls.length > 0 ? urls : undefined;
  const result = await deps.prompt.withSigner(
    (signer) => rekeyRelays(flowDepsOf(deps), signer, only),
    { purpose: 'revoke' }
  );
  if (result?.ok) {
    toast.success(deps.t('relay.tenant.rekey.done'));
    return;
  }
  announceFailure(deps, result ?? { code: RELAY_REKEY_NEEDS_ROOT, urls });
}

function announceFailure(deps: RekeyDeps, failure: { code: string; urls: string[] }): void {
  toast.error(
    deps.t('relay.tenant.rekey.failed', { error: relayErrorText(deps.t, failure.code) }),
    {
      duration: Number.POSITIVE_INFINITY,
      action: { label: deps.t('common.retry'), onClick: () => void retryRekey(deps, failure.urls) },
    }
  );
}
