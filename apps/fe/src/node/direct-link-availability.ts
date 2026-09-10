// 直连协商在**这个入口**上到底通不通的负缓存。
//
// 直连的前两步（`GET /api/mesh/connection?cid=`、`POST /api/rtc/authorize`）必须由**目标
// node 自己**作答：只有它手上有这条 Gateway WS 的 connectionId。经中转角色的入口访问时，
// 这两条请求会被入口自己答成 401（body 里的 `nodeId` 是入口而不是目标 node）——
// 这不是「目标 node 的会话没了」，而是「这条入口给不出直连」。
//
// 每次 WS 重连都会新起一次协商，于是同一条注定 401 的请求被反复发出（现网每次建连各一次）。
// 这里按 entry+node 记一次结论并压 30 分钟：期间不再建直连控制器，连接老老实实走 WS。
// 缓存只在内存里（刷新即失效），入口换了、或页面重开都会重新试一次。

import { getMeshNodesState } from './mesh-nodes';

/** 负结论的有效期。 */
export const DIRECT_LINK_NEGATIVE_TTL_MS = 30 * 60_000;

/** 直连协商的两条端点（相对目标 node 的路径，不含 `/n/<id>` 前缀）。 */
const NEGOTIATION_PATHS = new Set(['/api/mesh/connection', '/api/rtc/authorize']);

const unavailableUntil = new Map<string, number>();

function cacheKey(entryNodeId: string | null, nodeId: string): string {
  return `${entryNodeId ?? 'unknown'}→${nodeId}`;
}

/** 当前入口自身的 nodeId；`/api/auth/mode` 还没落地时为 null（按「未知入口」记账）。 */
export function currentEntryNodeId(): string | null {
  return getMeshNodesState().entryNodeId;
}

export function markDirectLinkUnavailable(
  nodeId: string,
  entryNodeId: string | null,
  now: number = Date.now()
): void {
  unavailableUntil.set(cacheKey(entryNodeId, nodeId), now + DIRECT_LINK_NEGATIVE_TTL_MS);
}

export function isDirectLinkUnavailable(
  nodeId: string,
  entryNodeId: string | null,
  now: number = Date.now()
): boolean {
  const key = cacheKey(entryNodeId, nodeId);
  const until = unavailableUntil.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  unavailableUntil.delete(key);
  return false;
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

/** 这条 401 是「入口代答」吗：body 里的 nodeId 不是目标 node，就不是目标 node 的结论。 */
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

export interface DirectLinkClientLike {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * 给直连控制器用的 REST 客户端包一层：协商端点被入口代答成 401 时记下负结论并回调宿主，
 * 由宿主停掉这次直连。除此之外一个字节都不改，请求照常返回给控制器自己处理。
 */
export function watchDirectNegotiation(
  nodeId: string,
  client: DirectLinkClientLike,
  onUnavailable: () => void
): DirectLinkClientLike {
  return {
    fetch(path, init) {
      return client.fetch(path, init).then((res) => {
        if (res.status !== 401 || !NEGOTIATION_PATHS.has(nodeRelativePath(path))) return res;
        void answeredByForeignNode(res, nodeId).then((foreign) => {
          if (!foreign) return;
          markDirectLinkUnavailable(nodeId, currentEntryNodeId());
          onUnavailable();
        });
        return res;
      });
    },
  };
}
