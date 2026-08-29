// 跨重启的「下一步开哪条向导」记号。
//
// 退出 mesh 会重写 env 并重启网关，页面必须整页刷新（鉴权模式变了，SPA 内部状态保不住）。
// 刷新之后组件树全新，只能靠 sessionStorage 把意图带过去。这里**只放路径名**，不放任何秘密。

export const SETUP_INTENT_KEY = 'tmex.setup.intent';

export type SetupIntent = 'become-hub' | 'join-hub';

export interface IntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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
  return value === 'become-hub' || value === 'join-hub';
}

export function writeSetupIntent(
  intent: SetupIntent,
  storage: IntentStorage | null = browserIntentStorage()
): void {
  try {
    storage?.setItem(SETUP_INTENT_KEY, intent);
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

/** 读一次就清掉：向导已经按它开了，再刷新一次不该又被劫持到同一条路径。 */
export function takeSetupIntent(
  storage: IntentStorage | null = browserIntentStorage()
): SetupIntent | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(SETUP_INTENT_KEY) ?? null;
  } catch {
    return null;
  }
  clearSetupIntent(storage);
  return isSetupIntent(raw) ? raw : null;
}
