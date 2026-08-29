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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function pickPaneById(
  windows: TmuxWindow[],
  paneId: string
): { window: TmuxWindow; pane: TmuxPane } | null {
  for (const window of windows) {
    const pane = window.panes.find((item) => item.id === paneId);
    if (pane) {
      return { window, pane };
    }
  }

  return null;
}

function pickByIdOrActiveOrFirst<T extends { id: string; active: boolean }>(
  items: T[],
  id: string | undefined
): T | undefined {
  return (
    (id ? items.find((item) => item.id === id) : undefined) ??
    items.find((item) => item.active) ??
    items[0]
  );
}

function locateWindowAndPane(
  windows: TmuxWindow[],
  paneId: string | undefined,
  windowId: string | undefined
): { window: TmuxWindow | undefined; pane: TmuxPane | undefined } {
  const matched = paneId ? pickPaneById(windows, paneId) : null;
  if (matched) {
    return matched;
  }

  const window = pickByIdOrActiveOrFirst(windows, windowId);
  if (!window) {
    return { window: undefined, pane: undefined };
  }

  return { window, pane: pickByIdOrActiveOrFirst(window.panes, paneId) };
}

function buildPaneUrl(
  siteUrl: string,
  deviceId: string,
  window: TmuxWindow | undefined,
  pane: TmuxPane | undefined
): string | undefined {
  if (!window || !pane) {
    return undefined;
  }
  const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl;
  return `${base}/devices/${encodeURIComponent(deviceId)}/windows/${encodeURIComponent(window.id)}/panes/${encodeURIComponent(pane.id)}`;
}

export function resolvePaneContext(options: ResolvePaneContextOptions): PaneLocationContext {
  const { deviceId, snapshot, rawData } = options;
  const raw = (rawData as Record<string, unknown> | undefined) ?? {};
  const bellWindowId = nonEmptyString(raw.windowId);
  const bellPaneId = nonEmptyString(raw.paneId);

  if (!snapshot?.session) {
    return {
      windowId: bellWindowId,
      paneId: bellPaneId,
    };
  }

  const located = locateWindowAndPane(snapshot.session.windows, bellPaneId, bellWindowId);

  return {
    windowId: located.window?.id ?? bellWindowId,
    paneId: located.pane?.id ?? bellPaneId,
    windowIndex: located.window?.index,
    paneIndex: located.pane?.index,
    paneUrl: buildPaneUrl(options.siteUrl, deviceId, located.window, located.pane),
    paneTitle: located.pane?.title,
    paneCurrentCommand: located.pane?.currentCommand,
  };
}
