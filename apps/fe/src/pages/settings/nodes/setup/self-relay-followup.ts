// 「重启后提示接入本机中继」的一次性记号。
//
// `relay,node` 设置完成会重启并整页刷新，SPA 状态全丢。中继起来之后本机还得以租户身份
// 接一次自己的中继，这条记号就是用来在重启后把那个入口顶到眼前的。与 setup 记号一样：
// 只放路径名、有保质期、读一次即清。

import type { IntentStorage } from '../membership/intent';
import { browserIntentStorage } from '../membership/intent';

export const SELF_RELAY_FOLLOW_UP_KEY = 'tmex.setup.followUp';

/** 记号里唯一认识的路径名；换了别的值一律当没有。 */
export const SELF_RELAY_FOLLOW_UP_PATH = 'enroll-self-relay';

/** 与 setup 记号同一量级：一次重启是几十秒，10 分钟足够宽松。 */
export const SELF_RELAY_FOLLOW_UP_TTL_MS = 10 * 60 * 1000;

export function writeSelfRelayFollowUp(
  storage: IntentStorage | null = browserIntentStorage(),
  now: number = Date.now()
): void {
  try {
    storage?.setItem(
      SELF_RELAY_FOLLOW_UP_KEY,
      JSON.stringify({ path: SELF_RELAY_FOLLOW_UP_PATH, at: now })
    );
  } catch {
    // 记不住只意味着少一个提示，不值得打断设置流程。
  }
}

/** 读一次就清掉；过期或脏值一律当没有。 */
export function takeSelfRelayFollowUp(
  storage: IntentStorage | null = browserIntentStorage(),
  now: number = Date.now()
): boolean {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SELF_RELAY_FOLLOW_UP_KEY) ?? null;
    storage?.removeItem(SELF_RELAY_FOLLOW_UP_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let record: { path?: unknown; at?: unknown };
  try {
    record = JSON.parse(raw) as { path?: unknown; at?: unknown };
  } catch {
    return false;
  }
  const { path, at } = record;
  if (path !== SELF_RELAY_FOLLOW_UP_PATH) return false;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age <= SELF_RELAY_FOLLOW_UP_TTL_MS;
}
