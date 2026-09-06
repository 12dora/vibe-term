// 带密码的分享链接：密码写在 fragment（`#p=`）里，不会随请求发给服务端，也不会进 Referer。
//
// 纯字符串工具，两端各用一半——分享方拼链接，被分享页开局读一次就把 fragment 抹掉，
// 免得密码一直留在地址栏与浏览历史里。分享弹窗在 `@vibeterm/panels` 里另有一份同名的拼装函数：
// 两个包不互相依赖，各自带一行实现与用例，比为四行字符串拼接开一条跨包出口划算。

export const SHARE_LINK_PASSWORD_KEY = 'p';

/** 覆盖 `url` 原有的 fragment；空密码原样返回。 */
export function buildShareLinkWithPassword(url: string, password: string): string {
  if (!password) return url;
  return `${url.split('#')[0]}#${SHARE_LINK_PASSWORD_KEY}=${encodeURIComponent(password)}`;
}

/** 从 `#p=…`（可与其它 fragment 参数共存）里取密码；没有或解码失败返回 `null`。 */
export function readPasswordFromHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const prefix = `${SHARE_LINK_PASSWORD_KEY}=`;
  for (const part of raw.split('&')) {
    if (!part.startsWith(prefix)) continue;
    const value = part.slice(prefix.length);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

export interface ShareLocationParts {
  pathname: string;
  search: string;
  hash: string;
}

export interface HashPasswordConsumption {
  password: string | null;
  /** 要写回地址栏的 URL；`null` 表示地址栏本来就没有 fragment，不必动 history。 */
  cleanedUrl: string | null;
}

/**
 * 读走 fragment 里的密码并给出抹掉它之后的地址。
 *
 * 「有 fragment 就抹」而不是「取到密码才抹」：`#p=` 坏了也一样是别人贴过来的东西，
 * 留在地址栏与浏览历史里没有任何好处。
 */
export function consumeHashPassword(location: ShareLocationParts): HashPasswordConsumption {
  return {
    password: readPasswordFromHash(location.hash),
    cleanedUrl: location.hash ? `${location.pathname}${location.search}` : null,
  };
}

export interface ShareLinkPrefill {
  /** 预填给密码表单的明文；没有就是 `undefined`。 */
  password: string | undefined;
  /** 每消费掉一次 fragment 就 +1：作为表单的 key，让它带着新预填重挂。 */
  seq: number;
}

export const EMPTY_SHARE_LINK_PREFILL: ShareLinkPrefill = { password: undefined, seq: 0 };

/** 没有新密码可填、原本也没填过就原样返回（不必让表单白重挂一次）。 */
export function advanceShareLinkPrefill(
  prev: ShareLinkPrefill,
  password: string | null
): ShareLinkPrefill {
  if (password === null && prev.password === undefined) return prev;
  return { password: password ?? undefined, seq: prev.seq + 1 };
}

export interface ShareLinkHistory {
  state: unknown;
  replaceState: (state: unknown, unused: string, url: string) => void;
}

/** 读走密码，并把地址栏里的 fragment 抹掉（`history.state` 原样保留）。 */
export function consumeShareLinkFragment(
  location: ShareLocationParts,
  history: ShareLinkHistory
): string | null {
  const consumed = consumeHashPassword(location);
  if (consumed.cleanedUrl !== null) history.replaceState(history.state, '', consumed.cleanedUrl);
  return consumed.password;
}
