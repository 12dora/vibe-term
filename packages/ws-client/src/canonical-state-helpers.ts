import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { ClientSendResult } from './client';
import type {
  GatewayRebaseReason,
  GatewaySubscriptionRejection,
  GatewaySubscriptionRejectionReason,
  GatewayTransportCommand,
  GatewayTransportEvent,
} from './transport-types';

export type CanonicalEvent = wsBorsh.CanonicalEvent;
export type MetadataSnapshotEvent = Extract<
  CanonicalEvent,
  { SourceMetadataSnapshot: unknown }
>['SourceMetadataSnapshot'];
export type MetadataPatchEvent = Extract<
  CanonicalEvent,
  { SourceMetadataPatch: unknown }
>['SourceMetadataPatch'];
export type PaneDataEvent = Extract<CanonicalEvent, { PaneData: unknown }>['PaneData'];
export type SubscriptionAppliedEvent = Extract<
  CanonicalEvent,
  { SubscriptionApplied: unknown }
>['SubscriptionApplied'];

export const ZERO_EPOCH = new Uint8Array(16);
export const MAX_METADATA_CHUNKS = 4_096;
export const MAX_METADATA_ASSEMBLIES = 8;
export const MAX_METADATA_BUFFERED_BYTES = 8 * 1024 * 1024;
export const METADATA_ASSEMBLY_TIMEOUT_MS = 15_000;
const LEGACY_PASTE_CHUNK_CHARS = 1_024;
const UTF8 = new TextEncoder();

export interface DesiredSubscriptions {
  paneIds: string[];
}

export interface DeviceMetadataState {
  metadataEpoch: Uint8Array;
  revision: bigint;
  serverEpoch: Uint8Array;
  paneEpochs: Map<string, Uint8Array>;
  snapshot: StateSnapshotPayload;
}

export interface MetadataSnapshotAssembly {
  metadataEpoch: Uint8Array;
  revision: bigint;
  totalChunks: number;
  chunks: Array<wsBorsh.SourceMetadataRecord[] | undefined>;
  receivedChunks: number;
  bufferedBytes: number;
  expiresAt: number;
  deviceIds: Set<string>;
}

export interface PendingTargetCommand {
  command: GatewayTransportCommand;
  bytes: number;
}

export function commandDeviceId(command: GatewayTransportCommand): string | null {
  return 'deviceId' in command ? command.deviceId : null;
}

export function isOrderedInput(command: GatewayTransportCommand): boolean {
  return command.type === 'terminal-input' || command.type === 'terminal-paste';
}

export function estimateCommandBytes(command: GatewayTransportCommand): number {
  if (command.type === 'terminal-input' || command.type === 'terminal-paste') {
    return UTF8.encode(command.data).byteLength + UTF8.encode(command.deviceId).byteLength + 128;
  }
  return 256;
}

export function inputByteGroups(
  command: Extract<GatewayTransportCommand, { type: 'terminal-input' | 'terminal-paste' }>
): Uint8Array[] {
  if (command.type === 'terminal-input') return [UTF8.encode(command.data)];
  const groups: Uint8Array[] = [];
  for (let offset = 0; offset < command.data.length; offset += LEGACY_PASTE_CHUNK_CHARS) {
    groups.push(UTF8.encode(command.data.slice(offset, offset + LEGACY_PASTE_CHUNK_CHARS)));
  }
  return groups;
}

export function clonePendingCommand(command: GatewayTransportCommand): GatewayTransportCommand {
  if (command.type === 'select-pane') {
    return { ...command, selectToken: copyBytes(command.selectToken) };
  }
  if (command.type === 'set-pane-subscriptions') {
    return { ...command, paneIds: [...command.paneIds] };
  }
  if (command.type === 'reorder-windows') {
    return { ...command, windowIds: [...command.windowIds] };
  }
  if (command.type === 'reorder-panes') {
    return { ...command, paneIds: [...command.paneIds] };
  }
  if (command.type === 'request-pane-screen') {
    return { ...command, requestId: copyBytes(command.requestId) };
  }
  if (command.type === 'request-pane-history') {
    return {
      ...command,
      requestId: copyBytes(command.requestId),
      cursor: command.cursor
        ? {
            paneEpoch: copyBytes(command.cursor.paneEpoch),
            historyEpoch: copyBytes(command.cursor.historyEpoch),
            beforeLine: command.cursor.beforeLine,
          }
        : null,
    };
  }
  return { ...command };
}

export function paneKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

export function bytesKey(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

export function discardSupersededMetadataAssemblies(
  assemblies: Map<string, MetadataSnapshotAssembly>,
  deviceIds: ReadonlySet<string>
): void {
  if (deviceIds.size === 0) return;
  for (const [key, assembly] of assemblies) {
    if (Array.from(assembly.deviceIds).some((deviceId) => deviceIds.has(deviceId))) {
      assemblies.delete(key);
    }
  }
}

export function mergeSendResult(left: ClientSendResult, right: ClientSendResult): ClientSendResult {
  if (left === 'overflow' || right === 'overflow') return 'overflow';
  if (left === 'backpressure' || right === 'backpressure') return 'backpressure';
  if (left === 'queued' || right === 'queued') return 'queued';
  return 'sent';
}

export function rejectionReason(reason: number): GatewaySubscriptionRejectionReason {
  if (reason === wsBorsh.SUBSCRIPTION_REJECTED_RESOURCE_EXHAUSTED) {
    return 'resource_exhausted';
  }
  if (reason === wsBorsh.SUBSCRIPTION_REJECTED_EPOCH_CHANGED) return 'epoch_changed';
  return 'not_found';
}

export function sourceGapReason(
  reason: number,
  fallback: GatewayRebaseReason
): GatewayRebaseReason {
  if (reason === wsBorsh.SOURCE_GAP_REASON_METADATA_GAP) return 'metadata_gap';
  if (reason === wsBorsh.SOURCE_GAP_REASON_PANE_GAP) return 'pane_gap';
  if (reason === wsBorsh.SOURCE_GAP_REASON_EPOCH_CHANGED) return 'epoch_changed';
  if (reason === wsBorsh.SOURCE_GAP_REASON_CACHE_EVICTED) return 'cache_evicted';
  if (reason === wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED) return 'resource_exhausted';
  return fallback;
}

export function subscriptionAppliedEvents(
  event: Extract<wsBorsh.CanonicalEvent, { SubscriptionApplied: unknown }>['SubscriptionApplied'],
  rejections: readonly GatewaySubscriptionRejection[]
): Array<Extract<GatewayTransportEvent, { type: 'subscription-applied' }>> {
  const deviceIds = new Set<string>();
  for (const pane of event.activePanes) deviceIds.add(pane.deviceId);
  for (const pane of event.hotPanes) deviceIds.add(pane.deviceId);
  for (const item of rejections) deviceIds.add(item.deviceId);
  return Array.from(deviceIds, (deviceId) => {
    const deviceRejections = rejections.filter((item) => item.deviceId === deviceId);
    return {
      type: 'subscription-applied',
      deviceId,
      generation: event.generation,
      paneIds: [...event.activePanes, ...event.hotPanes]
        .filter((pane) => pane.deviceId === deviceId)
        .map((pane) => pane.paneId),
      rejectedPaneIds: deviceRejections.map((item) => item.paneId),
      rejections: deviceRejections,
    };
  });
}
