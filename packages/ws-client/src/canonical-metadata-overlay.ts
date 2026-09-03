import type { StateSnapshotPayload, TmuxPane, TmuxWindow } from '@tmex/shared';

interface DeviceTreeOrder {
  windows: string[];
  panes: Map<string, string[]>;
  windowCustomNames: Map<string, string>;
  paneCustomNames: Map<string, string>;
  customNamesPending: boolean;
}

function orderByIds<T>(
  items: readonly T[],
  ids: readonly string[],
  idOf: (item: T) => string
): T[] {
  if (ids.length === 0) return [...items];
  const byId = new Map(items.map((item) => [idOf(item), item] as const));
  const used = new Set<string>();
  const ordered: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || used.has(id)) continue;
    ordered.push(item);
    used.add(id);
  }
  for (const item of items) {
    if (!used.has(idOf(item))) ordered.push(item);
  }
  return ordered;
}

export class CanonicalMetadataOverlay {
  private readonly orders = new Map<string, DeviceTreeOrder>();

  capture(snapshot: StateSnapshotPayload): void {
    if (!snapshot.session) return;
    this.orders.set(snapshot.deviceId, {
      windows: snapshot.session.windows.map((window) => window.id),
      panes: new Map(
        snapshot.session.windows.map((window) => [window.id, window.panes.map((pane) => pane.id)])
      ),
      windowCustomNames: new Map(
        snapshot.session.windows.flatMap((window) =>
          window.customName ? [[window.id, window.customName] as const] : []
        )
      ),
      paneCustomNames: new Map(
        snapshot.session.windows.flatMap((window) =>
          window.panes.flatMap((pane) =>
            pane.customName ? [[pane.id, pane.customName] as const] : []
          )
        )
      ),
      customNamesPending: true,
    });
  }

  apply(snapshot: StateSnapshotPayload): StateSnapshotPayload {
    const order = this.orders.get(snapshot.deviceId);
    if (!order || !snapshot.session) return snapshot;
    const applyCustomNames = order.customNamesPending;
    const windows = orderByIds<TmuxWindow>(
      snapshot.session.windows,
      order.windows,
      (window) => window.id
    ).map((window) => {
      const paneIds = order.panes.get(window.id);
      const panes = orderByIds<TmuxPane>(window.panes, paneIds ?? [], (pane) => pane.id).map(
        (pane) =>
          applyCustomNames ? withCustomName(pane, order.paneCustomNames.get(pane.id)) : pane
      );
      const orderedWindow = { ...window, panes };
      return applyCustomNames
        ? withCustomName(orderedWindow, order.windowCustomNames.get(window.id))
        : orderedWindow;
    });
    order.customNamesPending = false;
    order.windowCustomNames.clear();
    order.paneCustomNames.clear();
    return { ...snapshot, session: { ...snapshot.session, windows } };
  }
}

function withCustomName<T extends { customName?: string }>(item: T, customName?: string): T {
  if (customName) return { ...item, customName };
  if (item.customName === undefined) return item;
  const { customName: _customName, ...next } = item;
  return next as T;
}
