// 「登录命令」对单个节点的可用性：与 `planLoginCodeTargets` 的跳过规则一致
// （离线、已暂停、版本低于 MIN_LOGIN_CODE_VERSION；缺版本号按过低处理）。
// 这里是入口 chunk 能碰到的纯函数，不能依赖懒加载的签发模块。

import type { NodeRow } from '@/node/mesh-nodes';
import { compareSemver } from '@vibeterm/shared';
import { MIN_LOGIN_CODE_VERSION } from '@vibeterm/shared/auth';

type LoginCodeRow = Pick<NodeRow, 'isSelf' | 'online' | 'version' | 'paused'>;

export type LoginCodeIneligibleReason = 'offline' | 'paused' | 'outdated';

export function loginCodeIneligibleReason(row: LoginCodeRow): LoginCodeIneligibleReason | null {
  if (!row.isSelf && !row.online) return 'offline';
  if (!row.isSelf && row.paused === true) return 'paused';
  const version = row.version ?? null;
  if (!version || (compareSemver(version, MIN_LOGIN_CODE_VERSION) ?? -1) < 0) return 'outdated';
  return null;
}

/** 禁用原因的悬浮提示；可用时没有提示。 */
export function loginCodeMenuTitle(
  reason: LoginCodeIneligibleReason | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string | undefined {
  if (reason === 'offline') return t('nodes.loginCode.menuOffline');
  if (reason === 'paused') return t('nodes.loginCode.menuPaused');
  if (reason === 'outdated') {
    return t('nodes.loginCode.menuOutdated', { version: MIN_LOGIN_CODE_VERSION });
  }
  return undefined;
}

/** 选中行里能生成登录命令的那些。 */
export function loginCodeEligibleRows<T extends LoginCodeRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => loginCodeIneligibleReason(row) === null);
}
