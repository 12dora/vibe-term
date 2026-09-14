// 本机上级链路的唯一所有者：中继链路与中继动作都在这里创建一次，
// 本机卡与节点管理页都只拿它的只读快照。
//
// standalone 下必须整族传 `enabled: false`：不发任何 `/api/mesh/*` 请求。

import {
  type CredentialPromptHandle,
  decodeRootPublicKey,
  useCredentialPrompt,
  usePasskeys,
} from '@/auth/credential-prompt';
import { ensureFreshMeshNodes } from '@/node/mesh-nodes';
import { type UseMeshRelayResult, useMeshRelay } from '@/node/mesh-relay';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import { useCallback, useMemo } from 'react';
import { PLACEHOLDER_KDF, type ResolvedMode } from '../management/types';
import { type RelayActionsController, useRelayActions } from '../relay/use-relay-actions';

export interface LocalUplinkController {
  /** 本机在 mesh 里（standalone 下整族数据都不拉）。 */
  meshEnabled: boolean;
  api: AuthApi;
  /** 已确认带 uid / kdf 参数的模式；缺一不可签名，此时整族管理动作不可用。 */
  mode: ResolvedMode | null;
  relay: UseMeshRelayResult;
  relayActions: RelayActionsController;
  prompt: CredentialPromptHandle;
  /** 节点列表 + 中继链路一起重拉。 */
  refreshAll: () => void;
}

export interface LocalUplinkControllerOptions {
  mode: AuthModeResponse | null;
  api?: AuthApi;
}

export function useLocalUplinkController(
  options: LocalUplinkControllerOptions
): LocalUplinkController {
  const rawMode = options.mode;
  const api = options.api ?? defaultAuthApi;
  const meshEnabled = rawMode?.mode === 'mesh';

  const relay = useMeshRelay({ owner: true, enabled: meshEnabled });

  const hasCredentials = Boolean(rawMode?.uid && rawMode?.kdfParams);
  const mode: ResolvedMode | null =
    rawMode && hasCredentials
      ? {
          ...rawMode,
          uid: rawMode.uid as string,
          kdfParams: rawMode.kdfParams as AuthKdfParamsJson,
        }
      : null;

  const { passkeys } = usePasskeys(api, {
    enabled: hasCredentials && Boolean(rawMode?.passkeyAvailable),
  });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: Boolean(rawMode?.passkeyAvailable),
  });

  const refreshRelay = relay.refresh;
  const refreshAll = useCallback(() => {
    if (!meshEnabled) return;
    ensureFreshMeshNodes(api);
    refreshRelay();
  }, [api, meshEnabled, refreshRelay]);

  const relayActions = useRelayActions({ api, mode, prompt, onChanged: refreshAll });

  return useMemo(
    () => ({ meshEnabled, api, mode, relay, relayActions, prompt, refreshAll }),
    [meshEnabled, api, mode, relay, relayActions, prompt, refreshAll]
  );
}
