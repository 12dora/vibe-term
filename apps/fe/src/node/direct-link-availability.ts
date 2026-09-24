// 直连协商在**这个入口**上到底通不通的负缓存。
//
// 直连的前两步（`GET /api/mesh/connection?cid=`、`POST /api/rtc/authorize`）必须由**目标
// node 自己**作答：只有它手上有这条 Gateway WS 的 connectionId。经中转角色的入口访问时，
// 这两条请求会被入口自己答成 401（body 里的 `nodeId` 是入口而不是目标 node）——
// 多半是「这条入口给不出直连」。
//
// 每次 WS 重连都会新起一次协商，于是同一条注定 401 的请求被反复发出（现网每次建连各一次）。
// 这里按 entry+node 记一次结论并压 30 分钟：期间不再建直连控制器，连接老老实实走 WS。
//
// 两条刻意的保守规则：
//   * **入口自己是谁还不知道（`/api/auth/mode` 没落地）时既不记也不查**。记在
//     `unknown→node` 上、之后又按 `entry→node` 去查，等于记了一条永远命中不了的账；
//     反过来把 `unknown` 当通配符，则会把一次冷启动的偶发失败按到后来的任意入口头上。
//   * 中继也可能把**自己的 nodeId** 盖在一条如假包换的「会话过期」401 上，光看
//     nodeId 分不出这两种情况。所以该 node 一旦重新登录成功就把负结论清掉
//     （`markLoggedIn` 是唯一入口），不让一次误判把直连按住半小时。
//
// 目标 node 自己答 `503 DIRECT_UNAVAILABLE`（眼下给不出直连）也记一笔，但只压 10 分钟：
// 那是目标当前的状态（插件没装、指纹没就绪），不像代答 401 那样是入口的固有属性。
// 转发器的 `503 NODE_UNREACHABLE` 是链路抖动，不进这里，由直连控制器的 authorize 熔断限流。
//
// 缓存只在内存里（刷新即失效）。

/** 负结论的有效期。 */
export const DIRECT_LINK_NEGATIVE_TTL_MS = 30 * 60_000;
/** 目标 node 答 `DIRECT_UNAVAILABLE` 时负结论的有效期。 */
export const DIRECT_UNAVAILABLE_TTL_MS = 10 * 60_000;

const RTC_AUTHORIZE_RELATIVE_PATH = '/api/rtc/authorize';
const DIRECT_UNAVAILABLE_CODE = 'DIRECT_UNAVAILABLE';

/** 直连协商的两条端点（相对目标 node 的路径，不含 `/n/<id>` 前缀）。 */
const NEGOTIATION_PATHS = new Set(['/api/mesh/connection', RTC_AUTHORIZE_RELATIVE_PATH]);

/** ICE 配置打 **entry** 的 `/api/mesh/rtc-config`，不必转发到目标 node。 */
export const RTC_CONFIG_RELATIVE_PATH = '/api/mesh/rtc-config';

const unavailableUntil = new Map<string, number>();

function cacheKey(entryNodeId: string, nodeId: string): string {
  return `${entryNodeId}→${nodeId}`;
}

export function markDirectLinkUnavailable(
  nodeId: string,
  entryNodeId: string | null,
  now: number = Date.now(),
  ttlMs: number = DIRECT_LINK_NEGATIVE_TTL_MS
): void {
  // 入口身份未知：记了也查不中，索性不记（下一次协商照常重试一遍）。
  if (!entryNodeId) return;
  unavailableUntil.set(cacheKey(entryNodeId, nodeId), now + ttlMs);
}

export function isDirectLinkUnavailable(
  nodeId: string,
  entryNodeId: string | null,
  now: number = Date.now()
): boolean {
  if (!entryNodeId) return false;
  const key = cacheKey(entryNodeId, nodeId);
  const until = unavailableUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  unavailableUntil.delete(key);
  return false;
}

/**
 * 该 node 重新登录成功：把它在**所有入口**上的负结论清掉。
 *
 * 负结论有可能是误判——中继会把自己的 nodeId 盖在真正的「会话过期」401 上。
 * 会话一换新，那条 401 的成因就不复存在，直连该重新试一次。
 */
export function clearDirectLinkUnavailableFor(nodeId: string): void {
  const suffix = `→${nodeId}`;
  for (const key of [...unavailableUntil.keys()]) {
    if (key.endsWith(suffix)) unavailableUntil.delete(key);
  }
}

/** 仅测试使用。 */
export function clearDirectLinkAvailability(): void {
  unavailableUntil.clear();
}

/** 去掉 `/n/<id>` 前缀，拿到相对目标 node 的路径。 */
function nodeRelativePath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? '';
  return withoutQuery.replace(/^\/n\/[^/]+/, '');
}

/** 这条 401 是「别人代答」吗：body 里的 nodeId 不是目标 node，就不是目标 node 的结论。 */
async function answeredByForeignNode(res: Response, nodeId: string): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { nodeId?: unknown } | null;
    const claimed = body?.nodeId;
    return typeof claimed === 'string' && claimed !== nodeId;
  } catch {
    // 读不出 body 就当不出结论：宁可下次再试一遍，也不要把能用的直连误封 30 分钟。
    return false;
  }
}

/** 目标 node 自己答的「眼下给不出直连」。 */
async function directUnavailable(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { code?: unknown } | null;
    return body?.code === DIRECT_UNAVAILABLE_CODE;
  } catch {
    return false;
  }
}

/** 这条协商响应该压多久的负结论；`0` / `null` 表示不压。 */
function negativeVerdictTtl(
  res: Response,
  relative: string,
  nodeId: string
): Promise<number> | null {
  if (res.status === 401) {
    return answeredByForeignNode(res, nodeId).then((hit) =>
      hit ? DIRECT_LINK_NEGATIVE_TTL_MS : 0
    );
  }
  if (res.status === 503 && relative === RTC_AUTHORIZE_RELATIVE_PATH) {
    return directUnavailable(res).then((hit) => (hit ? DIRECT_UNAVAILABLE_TTL_MS : 0));
  }
  return null;
}

export interface DirectLinkClientLike {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * 给直连控制器用的 REST 客户端包一层：协商端点被别人代答成 401、或目标答
 * `503 DIRECT_UNAVAILABLE` 时记下负结论并回调宿主，由宿主停掉这次直连。
 * 除此之外一个字节都不改，请求照常返回给控制器自己处理。
 */
export function watchDirectNegotiation(
  nodeId: string,
  client: DirectLinkClientLike,
  onUnavailable: () => void,
  entryNodeId: () => string | null,
  entryClient?: DirectLinkClientLike
): DirectLinkClientLike {
  return {
    fetch(path, init) {
      const relative = nodeRelativePath(path);
      const target = relative === RTC_CONFIG_RELATIVE_PATH && entryClient ? entryClient : client;
      const routed = relative === RTC_CONFIG_RELATIVE_PATH ? RTC_CONFIG_RELATIVE_PATH : path;
      return target.fetch(routed, init).then((res) => {
        if (!NEGOTIATION_PATHS.has(relative)) return res;
        const verdict = negativeVerdictTtl(res, relative, nodeId);
        void verdict?.then((ttlMs) => {
          if (!ttlMs) return;
          markDirectLinkUnavailable(nodeId, entryNodeId(), Date.now(), ttlMs);
          onUnavailable();
        });
        return res;
      });
    },
  };
}
