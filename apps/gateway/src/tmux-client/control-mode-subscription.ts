import { createControlModeParser } from './control-mode-parser';
import { ControlModeMetadataBridge, RECONCILE_NOTIFICATION_TYPES } from './control-mode/metadata';
import { PaneParserRegistry } from './control-mode/pane-registry';
import type { ControlModeBlock, ControlModeNotification } from './control-mode/types';
import {
  CONTROL_STREAM_METRICS_INTERVAL_MS,
  ControlStreamMetrics,
  type ControlStreamMetricsSnapshot,
} from './control-stream-metrics';
import type { TmuxSourceMetadataEvent } from './events';
import type { PaneStreamNotification, PromptMarker } from './pane-stream-parser';
import {
  type PaneOutputMaterializationPredicate,
  finishPaneOutputMaterializationRequest,
  requestPaneOutputMaterializationPredicate,
} from './runtime/output-materialization';

const STRUCTURE_RECONCILE_MS = 50;

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
  /** 登记本次 attach 的 `tmex-park` 窗口，使其元数据事件不外泄。 */
  noteParkingWindow(windowId: string | null): void;
  dispose(): void;
}

export interface ControlModeSubscriptionOptions {
  metricsIntervalMs?: number;
  nowMs?: () => number;
  onMetrics?: (snapshot: ControlStreamMetricsSnapshot) => void;
  materializeOutput?: PaneOutputMaterializationPredicate;
}

export function createControlModeSubscription(
  callbacks: ControlModeSubscriptionCallbacks,
  options: ControlModeSubscriptionOptions = {}
): ControlModeSubscription {
  const nowMs = options.nowMs ?? Date.now;
  const metrics = options.onMetrics
    ? new ControlStreamMetrics(
        options.metricsIntervalMs ?? CONTROL_STREAM_METRICS_INTERVAL_MS,
        nowMs()
      )
    : null;
  let structureTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let materializeOutput = options.materializeOutput ?? null;
  let resolverDiscoveryAttempted = materializeOutput !== null;
  const metadata = new ControlModeMetadataBridge();
  const paneParsers = new PaneParserRegistry({
    onTitle: callbacks.onTitle,
    onBell: callbacks.onBell,
    onNotification: callbacks.onNotification,
    onPromptMarker: callbacks.onPromptMarker,
    onClipboardWrite: callbacks.onClipboardWrite,
    onThemeSubscription: callbacks.onThemeSubscription,
    onSourceMetadata: callbacks.onSourceMetadata,
    recordTitle: () => metrics?.recordTitle(),
    recordBell: () => metrics?.recordBell(),
    recordNotification: () => metrics?.recordNotification(),
  });

  function scheduleStructureChanged(): void {
    if (disposed || structureTimer) return;
    structureTimer = setTimeout(() => {
      structureTimer = null;
      if (disposed) return;
      metrics?.recordStructureChange();
      callbacks.onStructureChanged();
    }, STRUCTURE_RECONCILE_MS);
  }

  function handleNotification(notification: ControlModeNotification): void {
    const event = metadata.parse(notification);
    if (event) {
      callbacks.onSourceMetadata?.(event);
    }
    if (RECONCILE_NOTIFICATION_TYPES.has(notification.type)) {
      scheduleStructureChanged();
    }
    if (notification.type === 'pause') {
      callbacks.onPause?.(notification.args.trim());
    } else if (notification.type === 'continue') {
      callbacks.onContinue?.(notification.args.trim());
    }
  }

  function emitTerminalOutput(paneId: string, output: Uint8Array): void {
    if (resolverDiscoveryAttempted) {
      callbacks.onTerminalOutput(paneId, output);
      return;
    }
    resolverDiscoveryAttempted = true;
    const request = requestPaneOutputMaterializationPredicate(output);
    try {
      callbacks.onTerminalOutput(paneId, output);
    } finally {
      materializeOutput = finishPaneOutputMaterializationRequest(request);
    }
  }

  const parser = createControlModeParser({
    onOutput: (paneId, data) => {
      metrics?.recordControlOutput(data.length);
      const output = paneParsers.get(paneId).push(data, materializeOutput?.(paneId) ?? true);
      if (output.length > 0) {
        metrics?.recordTerminalOutput(output.length);
        emitTerminalOutput(paneId, output);
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
      paneParsers.prune(validPaneIds);
    },
    noteParkingWindow(windowId) {
      metadata.noteParkingWindow(windowId);
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
