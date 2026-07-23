import {
  type ControlModeBlock,
  type ControlModeNotification,
  createControlModeParser,
} from './control-mode-parser';
import {
  CONTROL_STREAM_METRICS_INTERVAL_MS,
  ControlStreamMetrics,
  type ControlStreamMetricsSnapshot,
} from './control-stream-metrics';
import type { TmuxSourceMetadataEvent } from './events';
import {
  type PaneStreamNotification,
  type PaneStreamParser,
  type PromptMarker,
  createPaneStreamParser,
} from './pane-stream-parser';

const STRUCTURE_RECONCILE_MS = 50;

const RECONCILE_NOTIFICATION_TYPES = new Set(['sessions-changed', 'window-add']);

export const SOURCE_METADATA_SUBSCRIPTION_COMMANDS = [
  'refresh-client -B "tmex-cwd:%*:#{pane_current_path}"\n',
  'refresh-client -B "tmex-command:%*:#{pane_current_command}"\n',
] as const;

export interface ControlModeSubscriptionCallbacks {
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTitle: (paneId: string, title: string) => void;
  onBell: (paneId: string) => void;
  onNotification: (paneId: string, notification: PaneStreamNotification) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onThemeSubscription?: (paneId: string, subscribed: boolean) => void;
  onSourceMetadata?: (event: TmuxSourceMetadataEvent) => void;
  onPause?: (paneId: string) => void;
  onContinue?: (paneId: string) => void;
  onStructureChanged: () => void;
  onExit: (reason: string | null) => void;
  onBlockBegin?: (args: string) => boolean;
  onBlockEnd?: (block: ControlModeBlock) => void;
}

export interface ControlModeSubscription {
  push(chunk: Uint8Array): void;
  end(): void;
  prunePanes(validPaneIds: ReadonlySet<string>): void;
  dispose(): void;
}

export interface ControlModeSubscriptionOptions {
  metricsIntervalMs?: number;
  nowMs?: () => number;
  onMetrics?: (snapshot: ControlStreamMetricsSnapshot) => void;
}

export function createControlModeSubscription(
  callbacks: ControlModeSubscriptionCallbacks,
  options: ControlModeSubscriptionOptions = {}
): ControlModeSubscription {
  const paneParsers = new Map<string, PaneStreamParser>();
  const nowMs = options.nowMs ?? Date.now;
  const metrics = options.onMetrics
    ? new ControlStreamMetrics(
        options.metricsIntervalMs ?? CONTROL_STREAM_METRICS_INTERVAL_MS,
        nowMs()
      )
    : null;
  let structureTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function getPaneParser(paneId: string): PaneStreamParser {
    const existing = paneParsers.get(paneId);
    if (existing) {
      return existing;
    }
    const parser = createPaneStreamParser({
      onTitle: (title) => {
        metrics?.recordTitle();
        callbacks.onTitle(paneId, title);
      },
      onCurrentPath: (currentPath) => {
        callbacks.onSourceMetadata?.({ type: 'pane-current-path', paneId, currentPath });
      },
      onBell: () => {
        metrics?.recordBell();
        callbacks.onBell(paneId);
      },
      onNotification: (notification) => {
        metrics?.recordNotification();
        callbacks.onNotification(paneId, notification);
      },
      onPromptMarker: (marker) => callbacks.onPromptMarker?.(paneId, marker),
      onClipboardWrite: (text) => callbacks.onClipboardWrite?.(paneId, text),
      onThemeSubscription: (subscribed) => callbacks.onThemeSubscription?.(paneId, subscribed),
    });
    paneParsers.set(paneId, parser);
    return parser;
  }

  function scheduleStructureChanged(): void {
    if (disposed || structureTimer) return;
    structureTimer = setTimeout(() => {
      structureTimer = null;
      if (disposed) return;
      metrics?.recordStructureChange();
      callbacks.onStructureChanged();
    }, STRUCTURE_RECONCILE_MS);
  }

  function splitFirst(value: string): [string, string] {
    const index = value.indexOf(' ');
    return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
  }

  function emitStructuredMetadata(notification: ControlModeNotification): void {
    const emit = callbacks.onSourceMetadata;
    if (!emit) return;
    const [first, rest] = splitFirst(notification.args.trim());
    switch (notification.type) {
      case 'session-renamed':
        if (first && rest) emit({ type: 'session-renamed', sessionId: first, name: rest });
        return;
      case 'session-window-changed': {
        const [windowId] = splitFirst(rest);
        if (first && windowId) emit({ type: 'session-window-changed', sessionId: first, windowId });
        return;
      }
      case 'window-renamed':
        if (first && rest) emit({ type: 'window-renamed', windowId: first, name: rest });
        return;
      case 'window-pane-changed': {
        const [paneId] = splitFirst(rest);
        if (first && paneId) emit({ type: 'window-pane-changed', windowId: first, paneId });
        return;
      }
      case 'layout-change': {
        const [layout] = splitFirst(rest);
        if (first && layout) emit({ type: 'layout-change', windowId: first, layout });
        return;
      }
      case 'window-close':
      case 'unlinked-window-close':
        if (first) emit({ type: 'window-close', windowId: first });
        return;
      case 'subscription-changed': {
        const separator = notification.args.indexOf(' : ');
        if (separator < 0) return;
        const header = notification.args.slice(0, separator).trim().split(/\s+/);
        const name = header[0];
        const paneId = header.find((part) => /^%\d+$/.test(part));
        const value = notification.args.slice(separator + 3);
        if (!paneId) return;
        if (name === 'tmex-cwd') {
          emit({ type: 'pane-current-path', paneId, currentPath: value });
        } else if (name === 'tmex-command') {
          emit({ type: 'pane-current-command', paneId, currentCommand: value });
        }
      }
    }
  }

  function handleNotification(notification: ControlModeNotification): void {
    emitStructuredMetadata(notification);
    if (RECONCILE_NOTIFICATION_TYPES.has(notification.type)) {
      scheduleStructureChanged();
    }
    if (notification.type === 'pause') {
      callbacks.onPause?.(notification.args.trim());
    } else if (notification.type === 'continue') {
      callbacks.onContinue?.(notification.args.trim());
    }
  }

  const parser = createControlModeParser({
    onOutput: (paneId, data) => {
      metrics?.recordControlOutput(data.length);
      const output = getPaneParser(paneId).push(data);
      if (output.length > 0) {
        metrics?.recordTerminalOutput(output.length);
        callbacks.onTerminalOutput(paneId, output);
      }
    },
    onNotification: handleNotification,
    onExit: (reason) => callbacks.onExit(reason),
    onBlockBegin: (args) => callbacks.onBlockBegin?.(args) ?? false,
    onBlockEnd: (block) => {
      metrics?.recordBlock();
      callbacks.onBlockEnd?.(block);
    },
  });

  return {
    push(chunk) {
      if (disposed) {
        return;
      }
      metrics?.recordRawChunk(chunk.length);
      parser.push(chunk);
      const snapshot = metrics?.takeIfDue(nowMs());
      if (snapshot) {
        options.onMetrics?.(snapshot);
      }
    },
    end() {
      if (disposed) {
        return;
      }
      parser.end();
    },
    prunePanes(validPaneIds) {
      for (const paneId of Array.from(paneParsers.keys())) {
        if (!validPaneIds.has(paneId)) {
          paneParsers.delete(paneId);
        }
      }
    },
    dispose() {
      disposed = true;
      if (structureTimer) {
        clearTimeout(structureTimer);
        structureTimer = null;
      }
      paneParsers.clear();
    },
  };
}
