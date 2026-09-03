import {
  type StateSnapshotPayload,
  type TmuxPane,
  type TmuxSession,
  type TmuxWindow,
  wsBorsh,
} from '@tmex/shared';

import {
  applyPaneHints,
  pickFallbackName,
  setDefinedStringField,
  setDefinedU16Field,
  setDefinedU32Field,
  setTruthyStringField,
} from './hierarchy-fields';
import {
  type PaneFieldHints,
  type PendingUpsert,
  SERVER_NATIVE_ID,
  boolValue,
  cloneKey,
  copyBytes,
  keyId,
  stringValue,
  u16Value,
  u32Value,
} from './types';

export interface MetadataHierarchyHost {
  deviceId: string;
  deviceName: string;
  getServerEpoch(): Uint8Array | null;
  getWindowCustomName(windowId: string): string | undefined;
  getPaneCustomName(paneId: string): string | undefined;
  getWindowTreeOrder(windowId: string): number | undefined;
  getPaneTreeOrder(windowId: string, paneId: string): number | undefined;
  ensurePaneEpoch(paneId: string): Uint8Array | null;
  takeUnknownPaneHints(paneId: string): PaneFieldHints | undefined;
}

export class MetadataHierarchyBuilder {
  constructor(private readonly host: MetadataHierarchyHost) {}

  buildDesired(snapshot: StateSnapshotPayload): Map<string, PendingUpsert> {
    const desired = new Map<string, PendingUpsert>();
    const device = this.buildDevice();
    putRecord(desired, device);
    const server = this.buildServer(device.key);
    putRecord(desired, server);
    if (!snapshot.session) return desired;
    this.addSession(desired, snapshot.session, server.key);
    return desired;
  }

  private buildDevice(): PendingUpsert {
    const device = this.newRecord(wsBorsh.SOURCE_ENTITY_DEVICE, this.host.deviceId, null);
    device.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(this.host.deviceName));
    device.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    return device;
  }

  private buildServer(deviceKey: wsBorsh.SourceEntityKey): PendingUpsert {
    const server = this.newRecord(wsBorsh.SOURCE_ENTITY_SERVER, SERVER_NATIVE_ID, deviceKey);
    server.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    return server;
  }

  private addSession(
    desired: Map<string, PendingUpsert>,
    session: TmuxSession,
    serverKey: wsBorsh.SourceEntityKey
  ): void {
    const record = this.buildSession(session, serverKey);
    putRecord(desired, record);
    this.addWindows(desired, session.windows, record.key);
  }

  private buildSession(session: TmuxSession, serverKey: wsBorsh.SourceEntityKey): PendingUpsert {
    const record = this.newRecord(wsBorsh.SOURCE_ENTITY_SESSION, session.id, serverKey);
    record.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(session.name));
    return record;
  }

  private addWindows(
    desired: Map<string, PendingUpsert>,
    windows: readonly TmuxWindow[],
    sessionKey: wsBorsh.SourceEntityKey
  ): void {
    for (const window of windows) {
      const record = this.buildWindow(window, sessionKey);
      putRecord(desired, record);
      this.addPanes(desired, window.panes, record.key);
    }
  }

  private buildWindow(window: TmuxWindow, sessionKey: wsBorsh.SourceEntityKey): PendingUpsert {
    const record = this.newRecord(wsBorsh.SOURCE_ENTITY_WINDOW, window.id, sessionKey);
    record.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(window.name));
    record.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(window.index));
    record.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(window.active));
    setDefinedStringField(record.fields, wsBorsh.SOURCE_FIELD_LAYOUT, window.layout);
    setTruthyStringField(
      record.fields,
      wsBorsh.SOURCE_FIELD_CUSTOM_NAME,
      pickFallbackName(this.host.getWindowCustomName(window.id), window.customName)
    );
    setDefinedU32Field(
      record.fields,
      wsBorsh.SOURCE_FIELD_TREE_ORDER,
      this.host.getWindowTreeOrder(window.id)
    );
    return record;
  }

  private addPanes(
    desired: Map<string, PendingUpsert>,
    panes: readonly TmuxPane[],
    windowKey: wsBorsh.SourceEntityKey
  ): void {
    for (const pane of panes) {
      putRecord(desired, this.buildPane(pane, windowKey));
    }
  }

  private buildPane(pane: TmuxPane, windowKey: wsBorsh.SourceEntityKey): PendingUpsert {
    const record = this.newRecord(wsBorsh.SOURCE_ENTITY_PANE, pane.id, windowKey);
    record.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(pane.index));
    record.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(pane.active));
    record.fields.set(wsBorsh.SOURCE_FIELD_WIDTH, u16Value(pane.width));
    record.fields.set(wsBorsh.SOURCE_FIELD_HEIGHT, u16Value(pane.height));
    setDefinedU16Field(record.fields, wsBorsh.SOURCE_FIELD_LEFT, pane.left);
    setDefinedU16Field(record.fields, wsBorsh.SOURCE_FIELD_TOP, pane.top);
    setDefinedStringField(record.fields, wsBorsh.SOURCE_FIELD_TITLE, pane.title);
    setDefinedStringField(record.fields, wsBorsh.SOURCE_FIELD_CURRENT_PATH, pane.currentPath);
    setDefinedStringField(record.fields, wsBorsh.SOURCE_FIELD_CURRENT_COMMAND, pane.currentCommand);
    const paneEpoch = this.host.ensurePaneEpoch(pane.id);
    if (!paneEpoch) throw new Error('server epoch must be established before pane projection');
    record.fields.set(wsBorsh.SOURCE_FIELD_PANE_EPOCH, { Bytes16: copyBytes(paneEpoch) });
    setTruthyStringField(
      record.fields,
      wsBorsh.SOURCE_FIELD_CUSTOM_NAME,
      pickFallbackName(this.host.getPaneCustomName(pane.id), pane.customName)
    );
    setDefinedU32Field(
      record.fields,
      wsBorsh.SOURCE_FIELD_TREE_ORDER,
      this.host.getPaneTreeOrder(windowKey.nativeId, pane.id)
    );
    applyPaneHints(record.fields, this.host.takeUnknownPaneHints(pane.id));
    return record;
  }

  newRecord(
    entityKind: number,
    nativeId: string,
    parent: wsBorsh.SourceEntityKey | null
  ): PendingUpsert {
    const serverEpoch = this.host.getServerEpoch();
    if (!serverEpoch) throw new Error('server epoch is not ready');
    return {
      key: {
        deviceId: this.host.deviceId,
        serverEpoch: copyBytes(serverEpoch),
        entityKind,
        nativeId,
      },
      parent: parent ? cloneKey(parent) : null,
      fields: new Map(),
    };
  }
}

function putRecord(desired: Map<string, PendingUpsert>, record: PendingUpsert): void {
  desired.set(keyId(record.key), record);
}
