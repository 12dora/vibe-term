import type { TmuxWindow } from '@tmex/shared';

const TITLE_SNAPSHOT_EMIT_INTERVAL_MS = 250;
const MAX_PENDING_PANE_TITLES = 256;

interface PaneTitleSnapshotCoordinatorOptions {
  getWindows: () => Iterable<TmuxWindow>;
  emitSnapshot: () => void;
  canEmit: () => boolean;
}

export class PaneTitleSnapshotCoordinator {
  private readonly pendingTitles = new Map<string, string>();
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: PaneTitleSnapshotCoordinatorOptions) {}

  noteTitle(paneId: string, title: string): void {
    this.rememberTitle(paneId, title);

    for (const window of this.options.getWindows()) {
      const pane = window.panes.find((candidate) => candidate.id === paneId);
      if (!pane) {
        continue;
      }
      if (pane.title === title) {
        return;
      }
      pane.title = title;
      this.scheduleEmit();
      return;
    }
  }

  consumeTitle(paneId: string, fallback: string): string {
    const title = this.pendingTitles.get(paneId);
    this.pendingTitles.delete(paneId);
    return title ?? fallback;
  }

  noteFullSnapshotEmitted(): void {
    this.clearEmitTimer();
  }

  reset(): void {
    this.clearEmitTimer();
    this.pendingTitles.clear();
  }

  private rememberTitle(paneId: string, title: string): void {
    if (!this.pendingTitles.has(paneId) && this.pendingTitles.size >= MAX_PENDING_PANE_TITLES) {
      const oldestPaneId = this.pendingTitles.keys().next().value;
      if (oldestPaneId) {
        this.pendingTitles.delete(oldestPaneId);
      }
    }
    this.pendingTitles.set(paneId, title);
  }

  private scheduleEmit(): void {
    if (this.emitTimer) {
      return;
    }
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.options.canEmit()) {
        this.options.emitSnapshot();
      }
    }, TITLE_SNAPSHOT_EMIT_INTERVAL_MS);
  }

  private clearEmitTimer(): void {
    if (!this.emitTimer) {
      return;
    }
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }
}
