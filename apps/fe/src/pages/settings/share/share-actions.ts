// 行内动作：分享存在它所属终端的那台节点上，终止 / 删除 / 密码读写一律用那台节点的客户端。
//
// 客户端工厂单独传进来，既让 `useShareTab` 只管状态，也让「远端那一行是不是发给了远端」
// 能被单测直接钉住。

import type { ApiClient } from '@tmex/api-client';
import { deleteShare, getSharePassword, revokeShare, updateSharePassword } from './share-api';
import type { ShareRow } from './share-rows';

export type ShareClientFor = (nodeId: string) => ApiClient;

export interface ShareRowApi {
  revoke: (row: ShareRow) => Promise<unknown>;
  remove: (row: ShareRow) => Promise<void>;
  password: (row: ShareRow) => Promise<string>;
  /** 返回被断开的观看者数量。 */
  changePassword: (row: ShareRow, password: string, endSessions: boolean) => Promise<number>;
}

export function createShareRowApi(clientFor: ShareClientFor): ShareRowApi {
  return {
    revoke: (row) => revokeShare(clientFor(row.nodeId), row.id),
    remove: (row) => deleteShare(clientFor(row.nodeId), row.id),
    password: async (row) => (await getSharePassword(clientFor(row.nodeId), row.id)).password,
    changePassword: async (row, password, endSessions) =>
      (await updateSharePassword(clientFor(row.nodeId), row.id, { password, endSessions }))
        .endedSessions,
  };
}
