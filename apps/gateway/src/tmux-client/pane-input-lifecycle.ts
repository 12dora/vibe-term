import type { TmuxConnectionOptions } from './connection-types';
import type { PaneInputPacer } from './pane-input-pacer';
import type { PaneRetentionConsumerLease } from './pane-retention';
import { bytesEqual } from './retention/bytes';

export class PaneInputLifecycle {
  private readonly mounted = new Map<PaneRetentionConsumerLease, Set<string>>();
  private serverEpoch: Uint8Array | null = null;
  private disposed = false;

  constructor(private readonly lane: PaneInputPacer) {}

  connectionOptions(
    options: TmuxConnectionOptions,
    hasPane: (paneId: string) => boolean
  ): TmuxConnectionOptions {
    return {
      ...options,
      onTerminalOutput: (paneId, bytes) => {
        this.lane.onOutput(paneId, bytes);
        options.onTerminalOutput(paneId, bytes);
      },
      onSourceReady: (epoch) => {
        if (this.serverEpoch && !bytesEqual(this.serverEpoch, epoch)) this.lane.clear();
        this.serverEpoch = epoch.slice();
        options.onSourceReady?.(epoch);
      },
      onSourceMetadata: (event) => {
        options.onSourceMetadata?.(event);
        if (event.type === 'window-close') this.lane.retainPanes(hasPane);
      },
      onSnapshot: (payload, revision) => {
        options.onSnapshot(payload, revision);
        this.lane.retainPanes(hasPane);
      },
    };
  }

  trackConsumer(lease: PaneRetentionConsumerLease): PaneRetentionConsumerLease {
    const apply = lease.applySubscriptions.bind(lease);
    const close = lease.close.bind(lease);
    lease.applySubscriptions = (generation, active, hot) => {
      const result = apply(generation, active, hot);
      this.updateMounted(lease, new Set(result.activePanes.map((pane) => pane.paneId)));
      return result;
    };
    lease.close = () => {
      close();
      this.updateMounted(lease, new Set());
      this.mounted.delete(lease);
    };
    return lease;
  }

  dispose(): void {
    this.disposed = true;
    this.mounted.clear();
    this.lane.dispose();
  }

  private updateMounted(lease: PaneRetentionConsumerLease, next: Set<string>): void {
    if (this.disposed) return;
    const previous = this.mounted.get(lease);
    this.mounted.set(lease, next);
    for (const paneId of previous ?? []) {
      if (!this.isMounted(paneId)) this.lane.dropPane(paneId);
    }
  }

  private isMounted(paneId: string): boolean {
    for (const panes of this.mounted.values()) {
      if (panes.has(paneId)) return true;
    }
    return false;
  }
}
