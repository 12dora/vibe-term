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
import {
  type PaneStreamNotification,
  type PaneStreamParser,
  type PromptMarker,
  createPaneStreamParser,
} from './pane-stream-parser';

const STRUCTURE_DEBOUNCE_MS = 150;

// 这些通知意味着会话结构（窗口/布局/活动 pane/名称）可能变化，需要刷新快照。
const STRUCTURE_NOTIFICATION_TYPES = new Set([
  'layout-change',
  'session-renamed',
  'session-window-changed',
  'sessions-changed',
  'unlinked-window-add',
  'unlinked-window-close',
  'unlinked-window-renamed',
  'window-add',
  'window-close',
  'window-pane-changed',
  'window-renamed',
]);

export interface ControlModeSubscriptionCallbacks {
  onTerminalOutput: (paneId: string, data: Uint8Array) => void;
  onTitle: (paneId: string, title: string) => void;
  onBell: (paneId: string) => void;
  onNotification: (paneId: string, notification: PaneStreamNotification) => void;
  onPromptMarker?: (paneId: string, marker: PromptMarker) => void;
  onClipboardWrite?: (paneId: string, text: string) => void;
  onThemeSubscription?: (paneId: string, subscribed: boolean) => void;
  onPause?: (paneId: string) => void;
  onContinue?: (paneId: string) => void;
  onStructureChanged: () => void;
  onExit: (reason: string | null) => void;
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
  let lastStructureEmitAt = 0;
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

  // 首发立即触发，突发期间合并为一次尾随触发，避免 %window-renamed 等高频通知刷快照。
  function scheduleStructureChanged(): void {
    if (disposed) {
      return;
    }
    const now = nowMs();
    if (structureTimer) {
      return;
    }
    if (now - lastStructureEmitAt >= STRUCTURE_DEBOUNCE_MS) {
      lastStructureEmitAt = now;
      metrics?.recordStructureChange();
      callbacks.onStructureChanged();
      return;
    }
    structureTimer = setTimeout(
      () => {
        structureTimer = null;
        if (disposed) {
          return;
        }
        lastStructureEmitAt = nowMs();
        metrics?.recordStructureChange();
        callbacks.onStructureChanged();
      },
      STRUCTURE_DEBOUNCE_MS - (now - lastStructureEmitAt)
    );
  }

  function handleNotification(notification: ControlModeNotification): void {
    if (STRUCTURE_NOTIFICATION_TYPES.has(notification.type)) {
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
