export interface ConnectionCleanupHost {
  cleanupPromise: Promise<void> | null;
  closeNotified: boolean;
  manualDisconnect: boolean;
  connected: boolean;
  callbacks: { onClose: () => void };
  stopControlClient(): void;
  disposeTransport(): Promise<void>;
}

export class ConnectionCleanup {
  constructor(private readonly host: ConnectionCleanupHost) {}

  async shutdownInternal(notifyClose: boolean): Promise<void> {
    const host = this.host;
    if (host.cleanupPromise) {
      await host.cleanupPromise;
      this.notifyCloseIfNeeded(notifyClose);
      return;
    }

    host.connected = false;
    host.cleanupPromise = (async () => {
      host.stopControlClient();
      await host.disposeTransport();
    })();

    await host.cleanupPromise;
    host.cleanupPromise = null;
    this.notifyCloseIfNeeded(notifyClose);
  }

  private notifyCloseIfNeeded(notifyClose: boolean): void {
    const host = this.host;
    if (notifyClose && !host.closeNotified && !host.manualDisconnect) {
      host.closeNotified = true;
      host.callbacks.onClose();
    }
  }
}
