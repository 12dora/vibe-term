import type { TunnelConnectorStatus, TunnelEdgeResolution } from '@tmex/shared';

/** 本次自愈是否仍然有效：手动停止 / 重启会作废在途的恢复。 */
export type EdgeRecoveryToken = { readonly cancelled: boolean };

export type EdgeRecoveryDeps = {
  now: () => number;
  delayMs: number;
  resolveEdge: () => Promise<TunnelEdgeResolution | null>;
  currentEdge: () => TunnelEdgeResolution | null;
  canRestart: () => boolean;
  restart: (edge: TunnelEdgeResolution, token: EdgeRecoveryToken) => Promise<void>;
  warn: (message: string) => void;
};

/**
 * 托管进程连续 delayMs 内 0 连接且当前用系统解析：重新解析一次，若识别到 fake-IP 且拿到
 * DoH 地址，就带 --edge 静态列表重启一次；连接恢复前不再重复。
 */
export class TunnelEdgeRecovery {
  private degradedSince: number | null = null;
  private done = false;
  private inFlight = false;
  private generation = 0;

  constructor(private readonly deps: EdgeRecoveryDeps) {}

  /** 同时兼作取消点：手动停止 / 重启后，在途的解析结果不再用于重启。 */
  reset(): void {
    this.degradedSince = null;
    this.done = false;
    this.generation += 1;
  }

  private token(generation: number): EdgeRecoveryToken {
    const self = this;
    return {
      get cancelled(): boolean {
        return generation !== self.generation;
      },
    };
  }

  private ready(connector: TunnelConnectorStatus): boolean {
    const degraded = connector.reachable === true && connector.readyConnections === 0;
    if (!degraded) {
      this.degradedSince = null;
      if ((connector.readyConnections ?? 0) > 0) this.done = false;
      return false;
    }
    if (this.degradedSince == null) this.degradedSince = this.deps.now();
    if (this.done || this.inFlight) return false;
    if (this.deps.now() - this.degradedSince < this.deps.delayMs) return false;
    if (this.deps.currentEdge()?.mode === 'static') return false;
    return this.deps.canRestart();
  }

  private degradedSeconds(): number {
    const now = this.deps.now();
    return Math.round((now - (this.degradedSince ?? now)) / 1000);
  }

  private async restartWithStaticEdge(token: EdgeRecoveryToken): Promise<void> {
    const edge = await this.deps.resolveEdge();
    if (token.cancelled) return;
    if (!edge || edge.mode !== 'static' || edge.edgeAddrs.length === 0) return;
    this.done = true;
    this.deps.warn(
      `[tunnel] restarting cloudflared with static edge after ${this.degradedSeconds()}s without edge connections: ${edge.edgeAddrs.join(',')}`
    );
    await this.deps.restart(edge, token);
    if (token.cancelled) return;
    this.degradedSince = null;
  }

  async maybeRecover(connector: TunnelConnectorStatus): Promise<void> {
    if (!this.ready(connector)) return;
    this.inFlight = true;
    const token = this.token(this.generation);
    try {
      await this.restartWithStaticEdge(token);
    } catch (error) {
      this.deps.warn(`[tunnel] edge recovery failed: ${String(error)}`);
    } finally {
      this.inFlight = false;
    }
  }
}
