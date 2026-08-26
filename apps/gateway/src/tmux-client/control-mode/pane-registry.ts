import type { TmuxSourceMetadataEvent } from '../events';
import {
  type PaneStreamNotification,
  type PaneStreamParser,
  type PromptMarker,
  createPaneStreamParser,
} from '../pane-stream-parser';

export interface PaneParserRegistryCallbacks {
  onTitle: (paneId: string, title: string) => void;
  onBell: (paneId: string) => void;
  onNotification: (paneId: string, notification: PaneStreamNotification) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onThemeSubscription?: (paneId: string, subscribed: boolean) => void;
  onSourceMetadata?: (event: TmuxSourceMetadataEvent) => void;
  recordTitle?: () => void;
  recordBell?: () => void;
  recordNotification?: () => void;
}

export class PaneParserRegistry {
  private readonly paneParsers = new Map<string, PaneStreamParser>();

  constructor(private readonly callbacks: PaneParserRegistryCallbacks) {}

  get(paneId: string): PaneStreamParser {
    const existing = this.paneParsers.get(paneId);
    if (existing) {
      return existing;
    }
    const parser = createPaneStreamParser({
      onTitle: (title) => {
        this.callbacks.recordTitle?.();
        this.callbacks.onTitle(paneId, title);
      },
      onCurrentPath: (currentPath) => {
        this.callbacks.onSourceMetadata?.({ type: 'pane-current-path', paneId, currentPath });
      },
      onBell: () => {
        this.callbacks.recordBell?.();
        this.callbacks.onBell(paneId);
      },
      onNotification: (notification) => {
        this.callbacks.recordNotification?.();
        this.callbacks.onNotification(paneId, notification);
      },
      onPromptMarker: (marker) => this.callbacks.onPromptMarker?.(paneId, marker),
      onClipboardWrite: (text) => this.callbacks.onClipboardWrite?.(paneId, text),
      onThemeSubscription: (subscribed) => this.callbacks.onThemeSubscription?.(paneId, subscribed),
    });
    this.paneParsers.set(paneId, parser);
    return parser;
  }

  prune(validPaneIds: ReadonlySet<string>): void {
    for (const paneId of Array.from(this.paneParsers.keys())) {
      if (!validPaneIds.has(paneId)) {
        this.paneParsers.delete(paneId);
      }
    }
  }

  clear(): void {
    this.paneParsers.clear();
  }
}
