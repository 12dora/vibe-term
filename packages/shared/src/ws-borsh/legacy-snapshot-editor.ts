import type { TmuxPane, TmuxSession } from '../contracts/tmux';
import type { StateSnapshotPayload } from '../contracts/websocket';
import { SOURCE_ENTITY_PANE, SOURCE_ENTITY_SESSION, SOURCE_ENTITY_WINDOW } from './canonical-state';
import type { LegacyMetadataEntityDiff } from './state-snapshot-diff';
import {
  applyPaneFields,
  applySessionFields,
  applyWindowFields,
} from './state-snapshot-field-appliers';

function cloneSession(session: TmuxSession | null): TmuxSession | null {
  if (!session) return null;
  return {
    ...session,
    windows: session.windows.map((window) => ({
      ...window,
      panes: window.panes.map((pane) => ({ ...pane })),
    })),
  };
}

export class LegacySnapshotEditor {
  private session: TmuxSession | null;

  constructor(snapshot: StateSnapshotPayload) {
    this.session = cloneSession(snapshot.session);
  }

  removeEntity(entityKind: number, nativeId: string): void {
    if (entityKind === SOURCE_ENTITY_SESSION && this.session?.id === nativeId) {
      this.session = null;
    } else if (entityKind === SOURCE_ENTITY_WINDOW && this.session) {
      this.session.windows = this.session.windows.filter((window) => window.id !== nativeId);
    } else if (entityKind === SOURCE_ENTITY_PANE && this.session) {
      this.session.windows = this.session.windows.map((window) => ({
        ...window,
        panes: window.panes.filter((pane) => pane.id !== nativeId),
      }));
    }
  }

  upsertSession(upsert: LegacyMetadataEntityDiff): void {
    if (!this.session || this.session.id !== upsert.nativeId) {
      this.session = { id: upsert.nativeId, name: '', windows: [] };
    }
    applySessionFields(this.session, upsert.fields);
  }

  upsertWindow(upsert: LegacyMetadataEntityDiff): void {
    if (!this.session) return;
    let window = this.session.windows.find((candidate) => candidate.id === upsert.nativeId);
    if (!window) {
      window = { id: upsert.nativeId, name: '', index: 0, active: false, panes: [] };
      this.session.windows.push(window);
    }
    applyWindowFields(window, upsert.fields);
  }

  upsertPane(upsert: LegacyMetadataEntityDiff): void {
    if (!this.session || !upsert.parentId) return;
    const destination = this.session.windows.find((window) => window.id === upsert.parentId);
    if (!destination) return;
    let pane: TmuxPane | undefined;
    for (const window of this.session.windows) {
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

  toPayload(deviceId: string): StateSnapshotPayload {
    return { deviceId, session: this.session };
  }
}
