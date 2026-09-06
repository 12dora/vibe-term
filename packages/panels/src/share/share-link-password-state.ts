// 「链接中包含密码」那一格的状态机（纯函数，供 use-share-link-password 使用）。
//
// 两条硬要求：
// 1. 关掉弹窗或换一条分享，勾选与已取回的明文都必须真的作废——上一条分享的密码跟到下一条
//    链接上、或者改密之后还把旧明文贴出去，都是把密码发错人。
// 2. 请求落地时要认领：`key` 说明这份状态属于哪一次「弹窗 × 分享」，`gen` 说明属于第几轮。
//    只比 `key` 不够——A → B → A 之后 `key` 又相等了，第一轮的响应仍会误落到第三轮上。

export interface LinkPasswordState {
  /** 这份状态属于哪一次「弹窗 × 分享」。 */
  key: string;
  /** 每次作废递增：在途请求据此判断自己是不是已经过期。 */
  gen: number;
  include: boolean;
  fetched: string | null;
  loading: boolean;
  error: string | null;
}

/** 一次取密码请求的归属：落地时必须与当时的状态严格对上。 */
export interface LinkPasswordClaim {
  key: string;
  gen: number;
}

export function linkPasswordKey(open: boolean, shareId: string | null): string {
  return `${open ? '1' : '0'} ${shareId ?? ''}`;
}

export function idleLinkPassword(key: string, gen = 0): LinkPasswordState {
  return { key, gen, include: false, fetched: null, loading: false, error: null };
}

/** 状态不属于当前 key 就换一份新的，并推进 `gen` 让在途请求作废。 */
export function projectLinkPassword(state: LinkPasswordState, key: string): LinkPasswordState {
  return state.key === key ? state : idleLinkPassword(key, state.gen + 1);
}

export function claimOf(state: LinkPasswordState): LinkPasswordClaim {
  return { key: state.key, gen: state.gen };
}

/** 认领成功才把补丁打上去；对不上说明中途关过窗或换过分享，原样返回。 */
export function claimLinkPassword(
  prev: LinkPasswordState,
  claim: LinkPasswordClaim,
  patch: Partial<Omit<LinkPasswordState, 'key' | 'gen'>>
): LinkPasswordState {
  if (prev.key !== claim.key || prev.gen !== claim.gen) return prev;
  return { ...prev, ...patch };
}
