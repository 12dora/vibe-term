import type { StateSnapshotPayload, TmuxPane } from '../index';
import { SOURCE_ENTITY_PANE, SOURCE_ENTITY_SESSION, SOURCE_ENTITY_WINDOW } from './canonical-state';
import { applyPaneFields } from './legacy-pane-fields';
import { applySessionFields, applyWindowFields } from './legacy-window-fields';
import type { LegacyStateSnapshotDiff } from './state-snapshot-diff';

export function referenceApply(
  snapshot: StateSnapshotPayload,
  diff: LegacyStateSnapshotDiff
): StateSnapshotPayload {
  let session = snapshot.session
    ? {
        ...snapshot.session,
        windows: snapshot.session.windows.map((window) => ({
          ...window,
          panes: window.panes.map((pane) => ({ ...pane })),
        })),
      }
    : null;

  for (const removal of diff.removals) {
    if (removal.entityKind === SOURCE_ENTITY_SESSION && session?.id === removal.nativeId) {
      session = null;
    } else if (removal.entityKind === SOURCE_ENTITY_WINDOW && session) {
      session.windows = session.windows.filter((window) => window.id !== removal.nativeId);
    } else if (removal.entityKind === SOURCE_ENTITY_PANE && session) {
      session.windows = session.windows.map((window) => ({
        ...window,
        panes: window.panes.filter((pane) => pane.id !== removal.nativeId),
      }));
    }
  }

  for (const upsert of diff.upserts) {
    if (upsert.entityKind === SOURCE_ENTITY_SESSION) {
      if (!session || session.id !== upsert.nativeId) {
        session = { id: upsert.nativeId, name: '', windows: [] };
      }
      applySessionFields(session, upsert.fields);
      continue;
    }
    if (!session) continue;
    if (upsert.entityKind === SOURCE_ENTITY_WINDOW) {
      let window = session.windows.find((candidate) => candidate.id === upsert.nativeId);
      if (!window) {
        window = { id: upsert.nativeId, name: '', index: 0, active: false, panes: [] };
        session.windows.push(window);
      }
      applyWindowFields(window, upsert.fields);
      continue;
    }
    if (upsert.entityKind !== SOURCE_ENTITY_PANE || !upsert.parentId) continue;
    const destination = session.windows.find((window) => window.id === upsert.parentId);
    if (!destination) continue;
    let pane: TmuxPane | undefined;
    for (const window of session.windows) {
      const index = window.panes.findIndex((candidate) => candidate.id === upsert.nativeId);
      if (index < 0) continue;
      pane = window.panes[index];
      if (window !== destination) window.panes.splice(index, 1);
      break;
    }
    if (!pane) {
      pane = {
        id: upsert.nativeId,
        windowId: destination.id,
        index: 0,
        active: false,
        width: 1,
        height: 1,
      };
    }
    pane.windowId = destination.id;
    if (!destination.panes.some((candidate) => candidate.id === pane?.id)) {
      destination.panes.push(pane);
    }
    applyPaneFields(pane, upsert.fields);
  }

  return { deviceId: snapshot.deviceId, session };
}
