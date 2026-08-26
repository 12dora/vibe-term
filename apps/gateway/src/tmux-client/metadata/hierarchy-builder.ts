import { type StateSnapshotPayload, wsBorsh } from '@tmex/shared';

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
  ensurePaneEpoch(paneId: string): Uint8Array | null;
  takeUnknownPaneHints(paneId: string): PaneFieldHints | undefined;
}

export class MetadataHierarchyBuilder {
  constructor(private readonly host: MetadataHierarchyHost) {}

  buildDesired(snapshot: StateSnapshotPayload): Map<string, PendingUpsert> {
    const desired = new Map<string, PendingUpsert>();
    const device = this.newRecord(wsBorsh.SOURCE_ENTITY_DEVICE, this.host.deviceId, null);
    device.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(this.host.deviceName));
    device.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    desired.set(keyId(device.key), device);

    const server = this.newRecord(wsBorsh.SOURCE_ENTITY_SERVER, SERVER_NATIVE_ID, device.key);
    server.fields.set(wsBorsh.SOURCE_FIELD_CONNECTED, boolValue(true));
    desired.set(keyId(server.key), server);
    if (!snapshot.session) return desired;

    const session = this.newRecord(wsBorsh.SOURCE_ENTITY_SESSION, snapshot.session.id, server.key);
    session.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(snapshot.session.name));
    desired.set(keyId(session.key), session);

    for (const window of snapshot.session.windows) {
      const windowRecord = this.newRecord(wsBorsh.SOURCE_ENTITY_WINDOW, window.id, session.key);
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_NAME, stringValue(window.name));
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(window.index));
      windowRecord.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(window.active));
      if (window.layout !== undefined) {
        windowRecord.fields.set(wsBorsh.SOURCE_FIELD_LAYOUT, stringValue(window.layout));
      }
      const windowCustomName = this.host.getWindowCustomName(window.id) ?? window.customName;
      if (windowCustomName) {
        windowRecord.fields.set(wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue(windowCustomName));
      }
      desired.set(keyId(windowRecord.key), windowRecord);

      for (const pane of window.panes) {
        const paneRecord = this.newRecord(wsBorsh.SOURCE_ENTITY_PANE, pane.id, windowRecord.key);
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_INDEX, u32Value(pane.index));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_ACTIVE, boolValue(pane.active));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_WIDTH, u16Value(pane.width));
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_HEIGHT, u16Value(pane.height));
        if (pane.left !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_LEFT, u16Value(pane.left));
        if (pane.top !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TOP, u16Value(pane.top));
        if (pane.title !== undefined)
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TITLE, stringValue(pane.title));
        if (pane.currentPath !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CURRENT_PATH, stringValue(pane.currentPath));
        }
        if (pane.currentCommand !== undefined) {
          paneRecord.fields.set(
            wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
            stringValue(pane.currentCommand)
          );
        }
        const paneEpoch = this.host.ensurePaneEpoch(pane.id);
        if (!paneEpoch) throw new Error('server epoch must be established before pane projection');
        paneRecord.fields.set(wsBorsh.SOURCE_FIELD_PANE_EPOCH, { Bytes16: copyBytes(paneEpoch) });
        const paneCustomName = this.host.getPaneCustomName(pane.id) ?? pane.customName;
        if (paneCustomName) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CUSTOM_NAME, stringValue(paneCustomName));
        }
        const hints = this.host.takeUnknownPaneHints(pane.id);
        if (hints?.title !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_TITLE, stringValue(hints.title));
        }
        if (hints?.currentPath !== undefined) {
          paneRecord.fields.set(wsBorsh.SOURCE_FIELD_CURRENT_PATH, stringValue(hints.currentPath));
        }
        if (hints?.currentCommand !== undefined) {
          paneRecord.fields.set(
            wsBorsh.SOURCE_FIELD_CURRENT_COMMAND,
            stringValue(hints.currentCommand)
          );
        }
        desired.set(keyId(paneRecord.key), paneRecord);
      }
    }
    return desired;
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
