// SW 各项决策的纯函数：缓存代的取舍、预缓存缺口的判定、导航时网络响应可否采信、
// 以及某个 404 是否值得让整代自毁。放这里是为了能用 bun:test 直接覆盖——
// 这些判断错一次的代价（离线冷启动失效、整代缓存被误删）在浏览器里极难复现。

/** 预缓存缺口达到多少个 chunk 才算「这一代不可靠」。个位数失败按需补下即可。 */
export const PARTIAL_CHUNK_THRESHOLD = 3;

/**
 * 安装期修剪。`caches.keys()` 按创建顺序返回，而 activate 会把除当前代以外的全删光，
 * 所以剩下的同前缀缓存里**最旧的那个**才是活动代，中间那些是「装完没等到激活就被顶掉」的残留。
 * 保留活动代（最旧）与正在装的这一代，删中间。
 */
export function planGenerationPrune(
  names: readonly string[],
  prefix: string,
  current: string
): string[] {
  const others = names.filter((name) => name.startsWith(prefix) && name !== current);
  return others.slice(1);
}

/** 激活期：同前缀里除当前代之外一律删掉 */
export function planGenerationSweep(
  names: readonly string[],
  prefix: string,
  current: string
): string[] {
  return names.filter((name) => name.startsWith(prefix) && name !== current);
}

/**
 * 预缓存缺口是否严重到要给这一代打标。字体缺一个终端就会用错字形度量，必须算；
 * 零星 chunk 缺失按需回源就行，超过阈值才说明这次安装整体不可靠（网络烂 / 服务端换了产物）。
 */
export function isMeaningfulGap(failed: readonly string[], fonts: readonly string[]): boolean {
  if (failed.length === 0) return false;
  const fontSet = new Set(fonts);
  return failed.some((url) => fontSet.has(url)) || failed.length > PARTIAL_CHUNK_THRESHOLD;
}

/**
 * 导航时拿到的网络响应可否顶掉缓存壳。5xx 要挡住：`vibeterm upgrade` 期间反代会短暂回
 * 502/504，用它替换掉一个能用的缓存壳是纯粹的倒退。302 跳转（Access 登录）必须放行。
 */
export function acceptsNetworkShell(status: number, type: string): boolean {
  if (type === 'opaqueredirect') return true;
  if (type === 'error') return false;
  return status > 0 && status < 500;
}

/** 从预缓存清单里取出路径集合，用于判断某个 404 是不是「本代自己缓存过的产物」 */
export function precachePathSet(...groups: readonly (readonly string[])[]): Set<string> {
  return new Set(groups.flat());
}

/** 请求 URL 的同源路径；解析不了就返回 null（不参与任何集合判定） */
export function requestPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** 缺口补齐后的新集合；没有变化返回 null，避免无谓写缓存 */
export function withGapFilled(missing: ReadonlySet<string>, path: string): Set<string> | null {
  if (!missing.has(path)) return null;
  const next = new Set(missing);
  next.delete(path);
  return next;
}
