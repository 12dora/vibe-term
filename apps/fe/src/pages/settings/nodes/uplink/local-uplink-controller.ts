// 本机上级链路的唯一所有者：hub 集合、hub 管理面、中继链路与中继动作都在这里创建一次，
// 本机卡与节点管理页都只拿它的只读快照。
//
// 之前这些 hook 挂在节点管理页里，中继操作也只能待在那张卡上；两 tab 版式把「接哪个上级」
// 挪进本机卡之后，两边都要读同一份状态，owner 必须上提，否则会出现两份轮询。
//
// standalone 下必须整族传 `enabled: false`：不发任何 `/api/mesh/*` 请求。

import {
  type CredentialPromptHandle,
  decodeRootPublicKey,
  useCredentialPrompt,
  usePasskeys,
} from '@/auth/credential-prompt';
import { type UseMeshHubsResult, useMeshHubs } from '@/node/mesh-hubs';
import {
  type HubNodeState,
  ensureFreshMeshNodes,
  useHubNode,
  useMeshNodes,
} from '@/node/mesh-nodes';
import { type UseMeshRelayResult, useMeshRelay } from '@/node/mesh-relay';
import type { AuthApi, AuthKdfParamsJson, AuthModeResponse } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { useCallback, useMemo } from 'react';
import { PLACEHOLDER_KDF, type ResolvedMode } from '../management/types';
import { type RelayActionsController, useRelayActions } from '../relay/use-relay-actions';

export interface LocalUplinkController {
  /** 本机在 mesh 里（standalone 下整族数据都不拉）。 */
  meshEnabled: boolean;
  api: AuthApi;
  /** 已确认带 uid / kdf 参数的模式；缺一不可签名，此时整族管理动作不可用。 */
  mode: ResolvedMode | null;
  hubs: UseMeshHubsResult;
  hub: HubNodeState;
  relay: UseMeshRelayResult;
  relayActions: RelayActionsController;
  prompt: CredentialPromptHandle;
  /** 节点列表 + hub 管理面 + hub 集合 + 中继链路一起重拉。 */
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

  const { nodes } = useMeshNodes({ enabled: meshEnabled, api });
  const hub = useHubNode(nodes, {
    enabled: meshEnabled,
    hubNodeId: rawMode?.hubNodeId ?? null,
  });
  const hubs = useMeshHubs({ owner: true, enabled: meshEnabled, api });
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

  // 管理动作可以用密码，也可以用本入口已注册的 passkey（设计 §2「用户密钥」）。
  const { passkeys } = usePasskeys(api, {
    enabled: hasCredentials && Boolean(rawMode?.passkeyAvailable),
  });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: Boolean(rawMode?.passkeyAvailable),
  });

  const refreshHub = hub.refresh;
  const refreshHubs = hubs.refresh;
  const refreshRelay = relay.refresh;
  // 中继链路也要跟着重拉：hub → 中继迁移之后，状态条得当场翻成中继版式，不能等下一拍轮询。
  //
  // 节点列表与 hub 管理面都走「一定比现在更新」的那条入口：`refreshAll` 是变更之后的刷新，
  // 复用在飞的那次请求只会拿回变更前的旧快照（待批准行不消失、新成员不出现）。
  const refreshAll = useCallback(() => {
    if (!meshEnabled) return;
    ensureFreshMeshNodes(api);
    refreshHub();
    refreshHubs();
    refreshRelay();
  }, [api, meshEnabled, refreshHub, refreshHubs, refreshRelay]);

  const relayActions = useRelayActions({ api, mode, prompt, onChanged: refreshAll });

  return useMemo(
    () => ({ meshEnabled, api, mode, hubs, hub, relay, relayActions, prompt, refreshAll }),
    [meshEnabled, api, mode, hubs, hub, relay, relayActions, prompt, refreshAll]
  );
}
