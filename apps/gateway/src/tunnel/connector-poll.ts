import type { TunnelConnectorStatus } from '@tmex/shared';

export type ConnectorPollDeps = {
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  shouldProbe: () => boolean;
  probe: () => Promise<TunnelConnectorStatus>;
  onSample: (connector: TunnelConnectorStatus) => Promise<void>;
};

/**
 * 托管 / 外部 cloudflared 的连接器轮询。代次同时兼作取消点：停止或重启后，
 * 在途的探测结果不再写回。
 */
export class ConnectorPollLoop {
  private gen = 0;
  private running = false;

  constructor(private readonly deps: ConnectorPollDeps) {}

  get generation(): number {
    return this.gen;
  }

  stop(): void {
    this.gen += 1;
    this.running = false;
  }

  sync(): void {
    if (this.deps.intervalMs <= 0 || !this.deps.shouldProbe()) {
      this.stop();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.gen += 1;
    const gen = this.gen;
    void this.loop(gen).finally(() => {
      if (this.gen === gen) this.running = false;
    });
  }

  private async loop(gen: number): Promise<void> {
    while (gen === this.gen) {
      await this.deps.sleep(this.deps.intervalMs);
      if (gen !== this.gen) break;
      if (!this.deps.shouldProbe()) break;
      const connector = await this.deps.probe();
      if (gen !== this.gen) break;
      await this.deps.onSample(connector);
    }
  }
}
