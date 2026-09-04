// 「通用」标签里改站点名 = 改本节点名。两条通道按上级形态二选一：
//   - hub 模式：hub 控制面（`POST /n/<hub>/api/hub/nodes/:id/rename`）；
//   - 中继模式：签一条 `rename-node` 密钥日志记录，经 `?hub=sync` 送上级（中继没有控制面）。
// 这里只负责挑出该走哪条通道，以及这条通道当前是否可用。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { useMeshHubs } from '@/node/mesh-hubs';
import { useHubNode, useMeshNodes, useSharedAuthMode } from '@/node/mesh-nodes';
import { useMeshRelay } from '@/node/mesh-relay';
import { renameNodeViaKeyLog } from '@/node/rename-node';
import type { AuthApi, AuthKdfParamsJson } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { type ReactElement, useCallback, useMemo } from 'react';
import { actionErrorText } from './nodes/management/errors';
import { PLACEHOLDER_KDF } from './nodes/management/types';
import type { SiteSettingsLinkage } from './site-settings-form';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type RenameNodeFn = (nodeId: string, name: string) => Promise<void>;

export interface NodeRenameChannel {
  /** 改名通道；通道当前不通时调用会抛出已本地化的原因。 */
  renameNode: RenameNodeFn;
  canRenameNode: boolean;
  refreshHub: () => void;
  /** 中继模式下改名要一次凭据；对话框由「通用」标签挂出来。 */
  dialog: ReactElement | null;
}

export interface NodeRenameChannelOptions {
  api?: AuthApi;
  /** 失败文案要本地化；宿主传自己的 `t`。 */
  t?: Translate;
}

const identityTranslate: Translate = (key) => key;

/**
 * 联动改名的通道。非联动（standalone / 老服务端）下这几个 hook 全部空转，不发任何
 * `/api/mesh/*` 请求；hub 集合的轮询归节点管理页所有，这里只要一份快照。
 *
 * hub 模式的目标 hub 必须是**写者**：多 hub 下 mesh 列表里的 `isHub` 会命中任意一台，挑中
 * 备 hub 的话 rename 会被 `HUB_NOT_WRITER` 拒掉。`/api/mesh/hubs` 的 `writerHubId` 就是当前收
 * 写入的那台。中继模式没有 writer 这回事，改判「有没有挂上中继」——一条都没挂上时提交必然超时。
 */
export function useNodeRenameChannel(
  linkage: SiteSettingsLinkage,
  options: NodeRenameChannelOptions = {}
): NodeRenameChannel {
  const linked = linkage.siteNameLinkedToNode;
  const api = options.api ?? defaultAuthApi;
  const t = options.t ?? identityTranslate;
  const { nodes } = useMeshNodes({ enabled: linked });
  const hubs = useMeshHubs({ enabled: linked });
  const hub = useHubNode(nodes, {
    enabled: linked,
    hubNodeId: hubs.writerHubId,
    pollIntervalMs: 0,
  });
  const relay = useMeshRelay({ enabled: linked });
  const { mode: rawMode } = useSharedAuthMode();

  const signMode = useMemo(
    () => (rawMode?.uid && rawMode.kdfParams ? { ...rawMode, uid: rawMode.uid } : null),
    [rawMode]
  );
  const { passkeys } = usePasskeys(api, {
    enabled: linked && relay.relayMode && Boolean(rawMode?.passkeyAvailable),
  });
  const prompt = useCredentialPrompt({
    kdfParams: (signMode?.kdfParams as AuthKdfParamsJson | undefined) ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: Boolean(rawMode?.passkeyAvailable),
  });

  const { withSigner } = prompt;
  const hubApi = hub.hubApi;
  const relayMode = relay.relayMode;

  const renameViaRelay = useCallback(
    async (nodeId: string, name: string) => {
      if (!signMode) throw new Error(t('settings.general.nameLinkedLocked'));
      const result = await withSigner(
        (signer) =>
          renameNodeViaKeyLog({ api, mode: signMode }, { nodeIdHex: nodeId, name }, signer),
        { purpose: 'revoke' }
      );
      if (!result) throw new Error(t('nodes.rename.cancelled'));
      if (!result.ok) throw new Error(actionErrorText(t, { code: result.code }));
    },
    [api, signMode, t, withSigner]
  );

  const renameViaHub = useCallback(
    async (nodeId: string, name: string) => {
      if (!hubApi) throw new Error(t('settings.general.nameLinkedLocked'));
      await hubApi.rename(nodeId, name);
    },
    [hubApi, t]
  );

  const viaRelay = Boolean(relayMode && signMode && relay.writable);
  const viaHub = Boolean(!relayMode && hubApi && hub.online && !hubs.writesBlocked);

  return {
    renameNode: relayMode ? renameViaRelay : renameViaHub,
    canRenameNode: Boolean(linked && linkage.nodeId) && (viaRelay || viaHub),
    refreshHub: hub.refresh,
    dialog: prompt.dialog,
  };
}
