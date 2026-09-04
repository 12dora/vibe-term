// 跨重启的「下一步开哪条向导」记号。
//
// 退出 mesh 会重写 env 并重启网关，页面必须整页刷新（鉴权模式变了，SPA 内部状态保不住）。
// 刷新之后组件树全新，只能靠 sessionStorage 把意图带过去。这里**只放路径名与目标角色**，
// 不放任何秘密。
//
// 记号带写入时间并且**有保质期**：退出请求可能以「不确定」的方式失败（网关先应用了改动才
// 崩掉／代理超时），这时记号既不能立刻清掉（重启真的发生了就该接力），也不能永远留着
// ——否则几天后一次无关的「退出 mesh」会把这条陈旧记号消费掉，莫名其妙地打开旧向导。

import type { SetupRelayRole } from '@tmex/api-client/local/types';

export const SETUP_INTENT_KEY = 'tmex.setup.intent';

/** 记号保质期：一次退出 + 重启的量级是几十秒，10 分钟已经足够宽松。 */
export const SETUP_INTENT_TTL_MS = 10 * 60 * 1000;

export type SetupIntent = 'become-hub' | 'join-hub' | 'join-relay' | 'become-relay';

/** `become-relay` 还要记住目标是纯中继还是中继兼节点，重启后表单直接预选。 */
export interface SetupIntentRecord {
  path: SetupIntent;
  role?: SetupRelayRole;
}

export interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 落盘格式：路径 + 写入时刻（+ 可选目标角色）。老记录没有 `role`，照样能读。 */
interface StoredIntent extends SetupIntentRecord {
  at: number;
}

/** 无 DOM 的测试环境里没有 sessionStorage；隐私模式下访问它还会直接抛。 */
export function browserIntentStorage(): IntentStorage | null {
  try {
    return (globalThis as { sessionStorage?: IntentStorage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function isSetupIntent(value: unknown): value is SetupIntent {
  return (
    value === 'become-hub' ||
    value === 'join-hub' ||
    value === 'join-relay' ||
    value === 'become-relay'
  );
}

function isRelayRole(value: unknown): value is SetupRelayRole {
  return value === 'relay' || value === 'relay,node';
}

function parseStored(raw: string | null): StoredIntent | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 老格式（裸字符串）或被别人写脏了：一律当没有。
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { path, at, role } = parsed as { path?: unknown; at?: unknown; role?: unknown };
  if (!isSetupIntent(path) || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return isRelayRole(role) ? { path, at, role } : { path, at };
}

export function writeSetupIntent(
  intent: SetupIntentRecord,
  storage: IntentStorage | null = browserIntentStorage(),
  now: number = Date.now()
): void {
  try {
    const record: StoredIntent = { ...intent, at: now };
    storage?.setItem(SETUP_INTENT_KEY, JSON.stringify(record));
  } catch {
    // 写不进去只意味着重启后要用户自己点一次路径，不值得打断退出流程。
  }
}

export function clearSetupIntent(storage: IntentStorage | null = browserIntentStorage()): void {
  try {
    storage?.removeItem(SETUP_INTENT_KEY);
  } catch {
    // 同上
  }
}

/** 读一次就清掉：向导已经按它开了，再刷新一次不该又被劫持到同一条路径。过期的当作没有。 */
export function takeSetupIntent(
  storage: IntentStorage | null = browserIntentStorage(),
  now: number = Date.now()
): SetupIntentRecord | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SETUP_INTENT_KEY) ?? null;
  } catch {
    return null;
  }
  clearSetupIntent(storage);
  const stored = parseStored(raw);
  if (!stored) return null;
  // 时钟回拨（at 在未来）同样不可信，按过期处理。
  const age = now - stored.at;
  if (age < 0 || age > SETUP_INTENT_TTL_MS) return null;
  const { at: _at, ...record } = stored;
  return record;
}
