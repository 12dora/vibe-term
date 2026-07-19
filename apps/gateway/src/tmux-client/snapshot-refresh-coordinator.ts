export class SnapshotRefreshCoordinator {
  private active: Promise<void> | null = null;
  private trailingRequested = false;

  constructor(private readonly refresh: () => Promise<void>) {}

  request(): Promise<void> {
    if (this.active) {
      this.trailingRequested = true;
      return this.active;
    }

    this.trailingRequested = false;
    const active = Promise.resolve().then(async () => {
      try {
        while (true) {
          await this.refresh();
          if (!this.trailingRequested) {
            break;
          }
          this.trailingRequested = false;
        }
      } finally {
        this.active = null;
      }
    });
    this.active = active;
    return active;
  }
}
