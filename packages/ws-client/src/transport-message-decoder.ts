// S2C 帧解码：按 wire kind 查表解码并投递 transport 事件。
// 未登记的 kind 一律忽略（与旧 switch 的 default 行为一致）；解码异常向上抛，由订阅侧统一记录。

import { wsBorsh } from '@tmex/shared';
import type {
  GatewayNodeEvent,
  GatewayRebaseReason,
  GatewayTransportEventHandler,
} from './transport-types';

function rebaseReasonFromSourceGap(reason: number): GatewayRebaseReason | undefined {
  if (reason === wsBorsh.SOURCE_GAP_REASON_METADATA_GAP) return 'metadata_gap';
  if (reason === wsBorsh.SOURCE_GAP_REASON_PANE_GAP) return 'pane_gap';
  if (reason === wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED) return 'epoch_changed';
  if (reason === wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED) return 'cache_evicted';
  if (reason === wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED) return 'resource_exhausted';
  return undefined;
}

function emitSourceGap(
  gap: Extract<wsBorsh.CanonicalEvent, { SourceGap: unknown }>['SourceGap'],
  emit: GatewayTransportEventHandler
): void {
  const reason = rebaseReasonFromSourceGap(gap.reason);
  if (!reason) return;
  if ('Pane' in gap.scope) {
    emit({
      type: 'rebase-required',
      deviceId: gap.scope.Pane.pane.deviceId,
      paneId: gap.scope.Pane.pane.paneId,
      reason,
    });
    return;
  }
  emit({ type: 'rebase-required', reason });
}

function decodeCanonicalEvent(payload: Uint8Array, emit: GatewayTransportEventHandler): void {
  const event = wsBorsh.decodeCanonicalEventPayload(payload).event;
  if (!('SourceGap' in event)) return;
  emitSourceGap(event.SourceGap, emit);
}

type MessageDecoder = (payload: Uint8Array, emit: GatewayTransportEventHandler) => void;

const MESSAGE_DECODERS = new Map<number, MessageDecoder>([
  [
    wsBorsh.KIND_DEVICE_CONNECTED,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceConnectedSchema, payload);
      emit({ type: 'device-connected', deviceId: decoded.deviceId });
    },
  ],
  [
    wsBorsh.KIND_DEVICE_DISCONNECTED,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.DeviceDisconnectedSchema, payload);
      emit({ type: 'device-disconnected', deviceId: decoded.deviceId });
    },
  ],
  [
    wsBorsh.KIND_DEVICE_EVENT,
    (payload, emit) => {
      emit({ type: 'device-event', event: wsBorsh.decodeDeviceEventPayload(payload) });
    },
  ],
  [
    wsBorsh.KIND_STATE_SNAPSHOT,
    (payload, emit) => {
      emit({ type: 'metadata-snapshot', snapshot: wsBorsh.decodeStateSnapshot(payload) });
    },
  ],
  [
    wsBorsh.KIND_STATE_SNAPSHOT_DIFF,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.StateSnapshotDiffSchema, payload);
      if (decoded.diffFormat !== wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON) return;
      emit({
        type: 'metadata-patch',
        deviceId: decoded.deviceId,
        patch: wsBorsh.decodeLegacyStateSnapshotDiff(decoded.diffBytes),
      });
    },
  ],
  [
    wsBorsh.KIND_TMUX_EVENT,
    (payload, emit) => {
      emit({ type: 'tmux-event', event: wsBorsh.decodeTmuxEventPayload(payload) });
    },
  ],
  [
    wsBorsh.KIND_SWITCH_ACK,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.SwitchAckSchema, payload);
      emit({
        type: 'selection-ack',
        deviceId: decoded.deviceId,
        selectToken: decoded.selectToken,
      });
    },
  ],
  [
    wsBorsh.KIND_TERM_HISTORY,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermHistorySchema, payload);
      emit({
        type: 'legacy-history',
        deviceId: decoded.deviceId,
        paneId: decoded.paneId,
        selectToken: decoded.selectToken,
        data: new TextDecoder().decode(decoded.data),
        alternateScreen: decoded.alternateScreen,
        modes: decoded.modes,
      });
    },
  ],
  [
    wsBorsh.KIND_LIVE_RESUME,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.LiveResumeSchema, payload);
      emit({ type: 'live-resume', deviceId: decoded.deviceId, selectToken: decoded.selectToken });
    },
  ],
  [
    wsBorsh.KIND_TERM_OUTPUT,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.TermOutputSchema, payload);
      emit({
        type: 'terminal-data',
        frame: { deviceId: decoded.deviceId, paneId: decoded.paneId, data: decoded.data },
      });
    },
  ],
  [
    wsBorsh.KIND_CLIPBOARD_WRITE,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.ClipboardWriteSchema, payload);
      emit({
        type: 'clipboard-write',
        deviceId: decoded.deviceId,
        paneId: decoded.paneId,
        text: decoded.text,
      });
    },
  ],
  [
    wsBorsh.KIND_SITE_THEME_UPDATE,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, payload);
      emit({
        type: 'site-theme-update',
        theme: decoded.theme === wsBorsh.SITE_THEME_LIGHT ? 'light' : 'dark',
      });
    },
  ],
  [
    wsBorsh.KIND_SETTINGS_UPDATE,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.SettingsUpdateS2CSchema, payload);
      emit({ type: 'settings-update', namespace: decoded.namespace });
    },
  ],
  [
    wsBorsh.KIND_ERROR,
    (payload, emit) => {
      const decoded = wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, payload);
      emit({ type: 'transport-error', error: new Error(decoded.message) });
    },
  ],
  [wsBorsh.KIND_CANONICAL_EVENT, decodeCanonicalEvent],
]);

export function decodeNodeEventMessage(payload: Uint8Array): GatewayNodeEvent | null {
  const decoded = wsBorsh.decodeNodeEvent(payload);
  const status =
    decoded.status === wsBorsh.NODE_EVENT_STATUS_ONLINE
      ? 'online'
      : decoded.status === wsBorsh.NODE_EVENT_STATUS_OFFLINE
        ? 'offline'
        : decoded.status === wsBorsh.NODE_EVENT_STATUS_REVOKED
          ? 'revoked'
          : null;
  if (!status) return null;
  return {
    type: 'node-event',
    nodeId: decoded.nodeId,
    status,
    reach: decoded.reach,
    inventory: decoded.inventory,
    version: decoded.version,
    directCapable: decoded.directCapable,
    name: decoded.name,
  };
}

/** 返回 false 表示该 kind 未登记解码器，调用方按“忽略”处理。 */
export function decodeGatewayTransportMessage(
  kind: number,
  payload: Uint8Array,
  emit: GatewayTransportEventHandler
): boolean {
  const decode = MESSAGE_DECODERS.get(kind);
  if (!decode) return false;
  decode(payload, emit);
  return true;
}
