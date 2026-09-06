// 行内写操作的状态机：哪一行在写、失败码放哪儿、写完失效哪台节点的分片键。
//
// 分享存在它所属终端的那台节点上，所有动作都经 `share-actions.ts` 按行取客户端；
// 这里只管「忙」与「错」两件事，客户端选择不在此处重复。

import { useCallback, useState } from 'react';
import type { ShareRowApi } from './share-actions';
import { shareErrorKey } from './share-api';
import { type ShareRow, shareRowKey } from './share-rows';

export interface ShareRowActions {
  /** 正在写入的那一行（`shareRowKey`）。 */
  busyRowKey: string | null;
  /** 失败的契约错误码；由界面翻译。 */
  actionErrorKey: string | null;
  revoke: (row: ShareRow) => void;
  remove: (row: ShareRow) => void;
  fetchPassword: (row: ShareRow) => Promise<string>;
  changePassword: (row: ShareRow, password: string, endSessions: boolean) => Promise<number>;
}

export function useShareRowActions(
  rowApi: ShareRowApi,
  invalidateNode: (nodeId: string) => Promise<void>
): ShareRowActions {
  const [busyRowKey, setBusyRowKey] = useState<string | null>(null);
  const [actionErrorKey, setActionErrorKey] = useState<string | null>(null);

  const runAction = useCallback(
    async (row: ShareRow, action: () => Promise<unknown>) => {
      setBusyRowKey(shareRowKey(row));
      setActionErrorKey(null);
      try {
        await action();
        await invalidateNode(row.nodeId);
      } catch (error) {
        setActionErrorKey(shareErrorKey(error));
      } finally {
        setBusyRowKey(null);
      }
    },
    [invalidateNode]
  );

  // 密码两族动作的失败要就地摆在对话框里（旧分享不可查看、密码太短），
  // 不能像 revoke/remove 那样吞进页头的 actionError，所以只借这里的「行内忙」标记。
  const runPasswordAction = useCallback(
    async <T>(row: ShareRow, action: () => Promise<T>): Promise<T> => {
      setBusyRowKey(shareRowKey(row));
      try {
        return await action();
      } finally {
        setBusyRowKey(null);
      }
    },
    []
  );

  const fetchPassword = useCallback(
    (row: ShareRow) => runPasswordAction(row, () => rowApi.password(row)),
    [rowApi, runPasswordAction]
  );

  const changePassword = useCallback(
    (row: ShareRow, password: string, endSessions: boolean) =>
      runPasswordAction(row, async () => {
        const ended = await rowApi.changePassword(row, password, endSessions);
        await invalidateNode(row.nodeId);
        return ended;
      }),
    [rowApi, invalidateNode, runPasswordAction]
  );

  return {
    busyRowKey,
    actionErrorKey,
    revoke: (row) => void runAction(row, () => rowApi.revoke(row)),
    remove: (row) => void runAction(row, () => rowApi.remove(row)),
    fetchPassword,
    changePassword,
  };
}
