// 吊销落账之后刷新中继令牌：吊销、批量移除、远程卸载共用这一段。
//
// 签名者沿用吊销时那一把（根钥路径在同一个 `withSigner` 回调里直接接着做，不再提示）。
// 已加入中继时吊销的凭据框只收账户密码（见 `revokeSignerOptions`），所以正常路径只有一次确认；
// 万一仍拿到通行密钥签名者（中继状态陈旧），也绝不自动再弹凭据框：给一行持久错误与重试，
// 重试时再弹仅密码的凭据框。刷新失败不回滚吊销。

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

/** 回调结束之后落提示：失败（含需要根密码）一律只给一行错误和重试，不自动弹凭据框。 */
export function reportRekey(deps: RekeyDeps, result: RelayRekeyResult | null): void {
  if (!result || result.ok) return;
  announceFailure(deps, result);
}

async function retryRekey(deps: RekeyDeps, urls: string[]): Promise<void> {
  const only = urls.length > 0 ? urls : undefined;
  const result = await deps.prompt.withSigner(
    (signer) => rekeyRelays(flowDepsOf(deps), signer, only),
    { purpose: 'revoke', passwordOnly: true }
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
