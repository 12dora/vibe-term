// 「多节点通知」开关的提交逻辑：先签一条 `notification-sink` 记录，再落本机开关。
//
// 顺序不可颠倒：转发方只认密钥日志里的签名声明，本机开关只管「这台机器现在收不收」。
// 记录没签成就不动本机开关，界面上的开关状态才与全网判据一致。

import type { RecordSigner } from '@/auth/key-log-actions';
import { setNotificationSinkViaKeyLog } from '@/node/notification-sink';
import type { ApiClient } from '@vibeterm/api-client';
import type { AuthApi } from '@vibeterm/api-client/auth/index';
import type { MeshNotificationState } from '@vibeterm/shared';
import {
  KEYLOG_TYPE_UNSUPPORTED_BY_NODES,
  MIN_NOTIFICATION_SINK_RECORD_VERSION,
} from '@vibeterm/shared/auth';
import { updateMeshNotificationState } from './mesh-api';

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 记录签名者拿不到（未登录 / 服务端没给 kdf 参数）时的失败码。 */
export const MESH_SINK_NO_MODE = 'MESH_SINK_NO_MODE';
/** 本机节点编号未知（老网关不下发 `selfNodeId`）：签不出记录。 */
export const MESH_SINK_NO_NODE_ID = 'MESH_SINK_NO_NODE_ID';

export class MeshSinkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MeshSinkError';
  }
}

/** 失败文案：版本门与两类前置条件各有专句，其余落回错误表。 */
export function meshSinkErrorText(t: Translate, code: string): string {
  if (code === KEYLOG_TYPE_UNSUPPORTED_BY_NODES) {
    return t('settings.notifications.mesh.nodesTooOld', {
      minVersion: MIN_NOTIFICATION_SINK_RECORD_VERSION,
    });
  }
  if (code === MESH_SINK_NO_MODE || code === MESH_SINK_NO_NODE_ID) {
    return t('settings.notifications.mesh.unavailable');
  }
  return t(`auth.errors.${code}`, { defaultValue: code });
}

export interface MeshSinkSubmitDeps {
  apiClient: ApiClient;
  authApi: AuthApi;
  mode: { uid: string; rootEpoch?: number | null } | null;
  selfNodeId: string | null | undefined;
  /** 取一次凭据并在作用域内签名；用户取消返回 `null`。 */
  withSigner: <T>(fn: (signer: RecordSigner) => Promise<T>) => Promise<T | null>;
}

/**
 * 提交一次开关变更。用户取消凭据交互时返回 `null`（开关保持原状，不报错）；
 * 记录被拒时抛 `MeshSinkError`，本机开关不动。
 */
export async function submitMeshSinkToggle(
  deps: MeshSinkSubmitDeps,
  enabled: boolean
): Promise<MeshNotificationState | null> {
  if (!deps.mode) throw new MeshSinkError(MESH_SINK_NO_MODE);
  if (!deps.selfNodeId) throw new MeshSinkError(MESH_SINK_NO_NODE_ID);
  const mode = deps.mode;
  const nodeIdHex = deps.selfNodeId;
  const signed = await deps.withSigner((signer) =>
    setNotificationSinkViaKeyLog({ api: deps.authApi, mode }, { nodeIdHex, enabled }, signer)
  );
  if (!signed) return null;
  if (!signed.ok) throw new MeshSinkError(signed.code);
  return updateMeshNotificationState(deps.apiClient, enabled);
}
