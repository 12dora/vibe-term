// 节点表 / 详情 / 待批准行共用的展示口径。纯函数，不读 store。
// 本模块只被懒路由引用：rest 包的 key 字面量不得进 eager 图（见 i18n/core-coverage）。

import { type NodeSignInState, nodeSignInState } from '@/auth/node-signin-state';
import type { Translate } from '@/lib/format-relative';
import type { Tone } from '@/lib/tone';
import { nodeReachComposeKeys } from '@/pages/settings/nodes/management/reach-label';
import { useEffect, useState } from 'react';
import type { NodeRow } from './merge-nodes';
import { nodeRelativeTime } from './node-address';

/** 离线相对时间按分钟刷新；行没有其它状态更新时也要从「刚刚」走到「N 分钟前」。 */
const RELATIVE_TIME_TICK_MS = 60_000;

export function useMinuteClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

const DASH = '—';

export interface NodeView {
  statusTone: Tone;
  statusText: string;
  reachText: string;
  addressText: string;
  lastSeenText: string;
  statusTitle?: string;
  /** 这一行当前该按哪一档说话；行内的登录入口据此决定出不出。 */
  signInState: NodeSignInState;
}

/** 表格行额外掌握的两个事实：登录失败码与「REST 正在退避」。都不来自 `/api/mesh/nodes`。 */
export interface NodeReachFacts {
  failureCode?: string | null;
  unreachable?: boolean;
}

export function buildNodeView(
  row: NodeRow,
  t: Translate,
  now: number,
  facts: NodeReachFacts = {}
): NodeView {
  const relative = nodeRelativeTime(t, row.lastSeenAt, now);
  const signIn = signInStateOf(row, facts);
  return {
    statusTone: statusToneOf(row, signIn),
    statusText: statusTextOf(row, t, relative, signIn),
    reachText: reachTextOf(row, t),
    addressText: row.address ?? DASH,
    lastSeenText: relative ?? DASH,
    statusTitle:
      !row.online && row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : undefined,
    signInState: signIn,
  };
}

/** 本机永远算 `ready`：本地 UI 已经过 localUiGuard，再报「未登录」是死循环。 */
function signInStateOf(row: NodeRow, facts: NodeReachFacts): NodeSignInState {
  return nodeSignInState({
    online: row.online,
    loggedIn: row.loggedIn || row.isSelf,
    failureCode: facts.failureCode ?? null,
    unreachable: facts.unreachable,
  });
}

function statusToneOf(row: NodeRow, signIn: NodeSignInState): Tone {
  if (row.pending) return 'warn';
  if (signIn === 'unreachable') return 'warn';
  return row.online ? 'ok' : 'muted';
}

function statusTextOf(
  row: NodeRow,
  t: Translate,
  relative: string | null,
  signIn: NodeSignInState
): string {
  if (row.pending) return t('nodes.status.pending');
  if (relative != null && !row.online) return t('nodes.status.offlineSince', { time: relative });
  if (!row.online) return t('nodes.status.offline');
  if (signIn === 'unreachable') return t('nodes.status.unreachable');
  return t(signIn === 'ready' ? 'nodes.status.onlineSignedIn' : 'nodes.status.onlineSignedOut');
}

function reachTextOf(row: NodeRow, t: Translate): string {
  const keys = nodeReachComposeKeys(row);
  if (!keys) return DASH;
  return keys.map((key) => t(key)).join(' · ');
}
