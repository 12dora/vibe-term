import type {
  StateSnapshotPayload,
  TmuxBellEventData,
  TmuxNotificationEventData,
  TmuxPane,
  TmuxWindow,
} from '@tmex/shared';

interface ResolvePaneContextOptions {
  deviceId: string;
  siteUrl: string;
  snapshot: StateSnapshotPayload | null;
  rawData: unknown;
}

export type PaneLocationContext = Pick<
  TmuxBellEventData & TmuxNotificationEventData,
  | 'windowId'
  | 'paneId'
  | 'windowIndex'
  | 'paneIndex'
  | 'paneUrl'
  | 'paneTitle'
  | 'paneCurrentCommand'
>;

export interface BuildPaneContextInput {
  deviceId: string;
  siteUrl: string;
  window?: TmuxWindow;
  pane?: TmuxPane;
  fallbackWindowId?: string;
  fallbackPaneId?: string;
}

function readOptionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readRawIds(rawData: unknown): { windowId?: string; paneId?: string } {
  if (!rawData || typeof rawData !== 'object') {
    return {};
  }
  const raw = rawData as Record<string, unknown>;
  return {
    windowId: readOptionalId(raw.windowId),
    paneId: readOptionalId(raw.paneId),
  };
}

function firstDefined<T>(candidates: ReadonlyArray<T | undefined | null>): T | undefined {
  for (const candidate of candidates) {
    if (candidate) {
      return candidate;
    }
  }
}

export function findPane(
  windows: readonly TmuxWindow[],
  paneId: string | undefined
): { window: TmuxWindow; pane: TmuxPane } | null {
  if (!paneId) {
    return null;
  }
  for (const window of windows) {
    const pane = window.panes.find((item) => item.id === paneId);
    if (pane) {
      return { window, pane };
    }
  }
  return null;
}

export function resolveWindowTitle(
  windows: readonly TmuxWindow[],
  options: { matchedWindow?: TmuxWindow; windowId?: string }
): TmuxWindow | undefined {
  return firstDefined([
    options.matchedWindow,
    options.windowId ? windows.find((window) => window.id === options.windowId) : undefined,
    windows.find((window) => window.active),
    windows[0],
  ]);
}

function resolvePane(
  window: TmuxWindow | undefined,
  options: { matchedPane?: TmuxPane; paneId?: string }
): TmuxPane | undefined {
  return firstDefined([
    options.matchedPane,
    options.paneId ? window?.panes.find((pane) => pane.id === options.paneId) : undefined,
    window?.panes.find((pane) => pane.active),
    window?.panes[0],
  ]);
}

function stripTrailingSlash(siteUrl: string): string {
  return siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
}

export function buildContext(input: BuildPaneContextInput): PaneLocationContext {
  const { window, pane } = input;
  const siteUrl = stripTrailingSlash(input.siteUrl);
  const paneUrl =
    window && pane
      ? `${siteUrl}/devices/${encodeURIComponent(input.deviceId)}/windows/${encodeURIComponent(window.id)}/panes/${encodeURIComponent(pane.id)}`
      : undefined;

  return {
    windowId: window?.id ?? input.fallbackWindowId,
    paneId: pane?.id ?? input.fallbackPaneId,
    windowIndex: window?.index,
    paneIndex: pane?.index,
    paneUrl,
    paneTitle: pane?.title,
    paneCurrentCommand: pane?.currentCommand,
  };
}

export function resolvePaneContext(options: ResolvePaneContextOptions): PaneLocationContext {
  const { deviceId, snapshot } = options;
  const { windowId, paneId } = readRawIds(options.rawData);

  if (!snapshot?.session) {
    return { windowId, paneId };
  }

  const windows = snapshot.session.windows;
  const matched = findPane(windows, paneId);
  const window = resolveWindowTitle(windows, { matchedWindow: matched?.window, windowId });
  const pane = resolvePane(window, { matchedPane: matched?.pane, paneId });
  return buildContext({
    deviceId,
    siteUrl: options.siteUrl,
    window,
    pane,
    fallbackWindowId: windowId,
    fallbackPaneId: paneId,
  });
}
