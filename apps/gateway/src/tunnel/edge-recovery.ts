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
export type EdgeRecoveryResult = 'static' | 'system' | 'cancelled';

export class TunnelEdgeRecovery {
  private degradedSince: number | null = null;
  private done = false;
  private inFlight = false;
  private generation = 0;
  private attempts = 0;

  constructor(private readonly deps: EdgeRecoveryDeps) {}

  /** 同时兼作取消点：手动停止 / 重启后，在途的解析结果不再用于重启。 */
  reset(): void {
    this.degradedSince = null;
    this.done = false;
    this.attempts = 0;
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

  private async restartWithStaticEdge(
    token: EdgeRecoveryToken,
    attempt: number
  ): Promise<EdgeRecoveryResult> {
    const edge = await this.deps.resolveEdge();
    if (token.cancelled) return 'cancelled';
    if (!edge || edge.mode !== 'static' || edge.edgeAddrs.length === 0) {
      this.log(attempt, `result=system degraded=${this.degradedSeconds()}s`, edge?.lastError);
      return 'system';
    }
    this.done = true;
    this.log(
      attempt,
      `result=static degraded=${this.degradedSeconds()}s edge=${edge.edgeAddrs.join(',')}`
    );
    await this.deps.restart(edge, token);
    if (token.cancelled) return 'cancelled';
    this.degradedSince = null;
    return 'static';
  }

  private log(attempt: number, detail: string, error?: string | null): void {
    this.deps.warn(
      `[tunnel] edge recovery attempt=${attempt} ${detail}${error ? ` error=${error}` : ''}`
    );
  }

  /** 每次轮询只要仍处于降级就再试一次，并且每次都留一行日志（成功、失败、被取消都算）。 */
  async maybeRecover(connector: TunnelConnectorStatus): Promise<void> {
    if (!this.ready(connector)) return;
    this.inFlight = true;
    this.attempts += 1;
    const attempt = this.attempts;
    const token = this.token(this.generation);
    try {
      const result = await this.restartWithStaticEdge(token, attempt);
      if (result === 'cancelled') this.log(attempt, 'result=cancelled');
    } catch (error) {
      this.log(attempt, 'result=error', String(error));
    } finally {
      this.inFlight = false;
    }
  }
}
