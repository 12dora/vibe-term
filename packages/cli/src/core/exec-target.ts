// exec / rsh 的目标解析：把用户写的 `<node>` | `<node>/<device>` | `<device>` 变成「去哪个 node、
// 用哪台设备」。node 名册查询的结果落进 targets.json，之后的调用不再打 `GET /api/mesh/nodes`。

import { isValidNodeId } from '@vibeterm/api-client/node-url';
import type { CliContext } from './context';
import { NotFoundError, UsageError } from './errors';
import { isSelfAlias, parseTarget } from './resolve';
import { type CachedTarget, TargetCache, bareKey, nodeKey } from './target-cache';

export type ExecRoute = {
  nodeId: string;
  nodeName: string;
  /** 缺省由目标 node 选第一台 local 设备。 */
  device?: string;
  /**
   * 路由来自缓存时的 node 名；随 open 发给目标 node 自检，防止名字已易主（node 改名、名字被别的
   * node 占用）而命令落到旧 node。按 id 写的目标与现查的路由不带。
   */
  expectName?: string;
};

function cachedRoute(ref: string, hit: CachedTarget, device?: string): ExecRoute {
  const name = hit.name.trim();
  const checkable = !isValidNodeId(ref) && name !== '' && !isValidNodeId(name);
  return {
    nodeId: hit.nodeId,
    nodeName: hit.name,
    ...(device ? { device } : {}),
    ...(checkable ? { expectName: name } : {}),
  };
}

export type ExecTargetPlan =
  | { kind: 'explicit'; nodeRef: string; device: string }
  | { kind: 'bare'; token: string };

/** 目标优先级：`<node>/` 前缀 > 调用方给的 node 覆盖 > 全局 `--node`；都没有就是单段目标。 */
export function planExecTarget(
  ctx: CliContext,
  rawTarget: string,
  nodeOverride?: string
): ExecTargetPlan {
  const parsed = parseTarget(rawTarget);
  if (parsed.location) {
    throw new UsageError('vibeterm exec does not take a window/pane location');
  }
  const nodeRef = parsed.node ?? (nodeOverride?.trim() || ctx.globals.node);
  if (nodeRef) return { kind: 'explicit', nodeRef, device: parsed.device };
  return { kind: 'bare', token: parsed.device };
}

/** 回退到 REST 设备解析（旧节点）时用的目标原文。 */
export function legacyTargetText(plan: ExecTargetPlan): string {
  return plan.kind === 'explicit' ? `${plan.nodeRef}/${plan.device}` : plan.token;
}

export function planCacheKey(plan: ExecTargetPlan): string {
  return plan.kind === 'explicit' ? nodeKey(plan.nodeRef) : bareKey(plan.token);
}

export class ExecTargets {
  private readonly cache: TargetCache;

  constructor(private readonly ctx: CliContext) {
    this.cache = TargetCache.open(ctx.configDir, ctx.globals.entry);
  }

  /** `<node>/<device>`：node 走缓存，`fresh` 时跳过缓存重新查名册。 */
  async explicitRoute(
    plan: Extract<ExecTargetPlan, { kind: 'explicit' }>,
    fresh: boolean
  ): Promise<{ route: ExecRoute; cached: boolean }> {
    const key = nodeKey(plan.nodeRef);
    const hit = fresh ? null : this.cache.get(key);
    if (hit) {
      return { route: cachedRoute(plan.nodeRef, hit, plan.device), cached: true };
    }
    const node = await this.ctx.resolver.resolveNode(plan.nodeRef);
    if (!isSelfAlias(plan.nodeRef)) this.cache.set(key, { nodeId: node.id, name: node.name });
    return {
      route: { nodeId: node.id, nodeName: node.name, device: plan.device },
      cached: false,
    };
  }

  /** 单段目标上次被解析成 node 的结果；没有或已过期为 null。 */
  cachedBareRoute(token: string): ExecRoute | null {
    const hit = this.cache.get(bareKey(token));
    return hit ? cachedRoute(token, hit) : null;
  }

  /** 单段目标不是入口上的设备时，按 node 名 / id 解析；该 node 用它自己的默认设备。 */
  async bareNodeRoute(token: string): Promise<ExecRoute> {
    try {
      const node = await this.ctx.resolver.resolveNode(token);
      this.cache.set(bareKey(token), { nodeId: node.id, name: node.name });
      return { nodeId: node.id, nodeName: node.name };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      throw new NotFoundError(
        `unknown device or node: ${token}`,
        'run: vibeterm devices ls, vibeterm nodes ls'
      );
    }
  }

  forget(plan: ExecTargetPlan): void {
    this.cache.drop(planCacheKey(plan));
  }
}
