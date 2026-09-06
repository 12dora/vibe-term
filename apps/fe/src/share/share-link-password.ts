// 带密码的分享链接：密码写在 fragment（`#p=`）里，不会随请求发给服务端，也不会进 Referer。
//
// 纯字符串工具，两端各用一半——分享方拼链接，被分享页开局读一次就把 fragment 抹掉，
// 免得密码一直留在地址栏与浏览历史里。分享弹窗在 `@tmex/panels` 里另有一份同名的拼装函数：
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
