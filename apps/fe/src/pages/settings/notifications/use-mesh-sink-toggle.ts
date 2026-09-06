// 「多节点通知」开关的凭据交互：与改名同一套（`useCredentialPrompt` + 作用域签名者）。
// 汇聚声明是持久记录，`sk_sess` 签不了，每次翻转开关都要用户当场确认一次密码或通行密钥。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { useSharedAuthMode } from '@/node/mesh-nodes';
import type { ApiClient } from '@vibeterm/api-client';
import type { AuthApi, AuthKdfParamsJson } from '@vibeterm/api-client/auth/index';
import { defaultAuthApi } from '@vibeterm/api-client/auth/index';
import type { MeshNotificationState } from '@vibeterm/shared';
import { type ReactElement, useCallback, useMemo } from 'react';
import { PLACEHOLDER_KDF } from '../nodes/management/types';
import { submitMeshSinkToggle } from './mesh-sink-toggle';

export interface MeshSinkToggleHandle {
  /** 提交一次变更；用户取消返回 `null`。 */
  submit: (enabled: boolean) => Promise<MeshNotificationState | null>;
  /** 凭据对话框；由卡片挂出来。 */
  dialog: ReactElement | null;
}

export interface MeshSinkToggleOptions {
  apiClient: ApiClient;
  /** 被操作节点的编号（来自 `GET /api/notifications/mesh`）。 */
  selfNodeId?: string | null;
  authApi?: AuthApi;
}

export function useMeshSinkToggle(options: MeshSinkToggleOptions): MeshSinkToggleHandle {
  const authApi = options.authApi ?? defaultAuthApi;
  const { mode: rawMode } = useSharedAuthMode();
  const signMode = useMemo(
    () => (rawMode?.uid && rawMode.kdfParams ? { ...rawMode, uid: rawMode.uid } : null),
    [rawMode]
  );
  const { passkeys } = usePasskeys(authApi, { enabled: Boolean(rawMode?.passkeyAvailable) });
  const prompt = useCredentialPrompt({
    kdfParams: (signMode?.kdfParams as AuthKdfParamsJson | undefined) ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: Boolean(rawMode?.passkeyAvailable),
  });

  const { withSigner } = prompt;
  const { apiClient, selfNodeId } = options;
  const submit = useCallback(
    (enabled: boolean) =>
      submitMeshSinkToggle(
        {
          apiClient,
          authApi,
          mode: signMode,
          selfNodeId,
          withSigner: (fn) => withSigner(fn, { purpose: 'notifySink' }),
        },
        enabled
      ),
    [apiClient, authApi, selfNodeId, signMode, withSigner]
  );

  return { submit, dialog: prompt.dialog };
}
