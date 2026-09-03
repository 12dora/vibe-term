const DEFAULT_RECOVERY_DELAY_MS = 250;

export class CanonicalMetadataRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private globalPending = false;
  private readonly pendingDevices = new Set<string>();

  constructor(
    private readonly recover: (() => void) | undefined,
    private readonly delayMs = DEFAULT_RECOVERY_DELAY_MS
  ) {}

  request(deviceId?: string): void {
    if (deviceId) this.pendingDevices.add(deviceId);
    else this.globalPending = true;
    if (!this.recover || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.globalPending = false;
      this.pendingDevices.clear();
      this.recover?.();
    }, this.delayMs);
  }

  resolved(deviceId: string): void {
    this.pendingDevices.delete(deviceId);
    if (this.globalPending || this.pendingDevices.size > 0) return;
    this.clearTimer();
  }

  reset(): void {
    this.globalPending = false;
    this.pendingDevices.clear();
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
