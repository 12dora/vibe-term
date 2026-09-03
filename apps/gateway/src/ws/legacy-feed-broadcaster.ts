import type { EventDevicePayload, StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import type { TmuxEvent } from '../tmux-client/events';
import { resolvePaneContext } from '../tmux/bell-context';
import { switchBarrier } from './borsh/switch-barrier';
import { classifySshError } from './error-classify';
import type { GatewayActivityMetrics } from './gateway-activity-metrics';
import type { GatewaySession } from './gateway-session';
import {
  deliverBell,
  deliverGenericEvent,
  deliverNotification,
  isEmptyNotification,
} from './legacy-event-delivery';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { TerminalOutputMetrics } from './terminal-output-metrics';
import type { DeviceConnectionEntry } from './types';

export interface LegacyFeedHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly terminalOutputBatcher: TerminalOutputBatcher;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  readonly gatewayActivityMetrics: GatewayActivityMetrics;
  terminalOutputEventsUntilMetricsCheck: number;
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
  sendChunked(session: GatewaySession, kind: number, payload: Uint8Array): boolean;
  sendTermOutput(
    session: GatewaySession,
    deviceId: string,
    paneId: string,
    data: Uint8Array,
    frameCache: Map<number, Uint8Array> | null
  ): number | null;
  encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array;
  reportTerminalOutputMetricsIfDue(): void;
  onStateSnapshotInstalled(deviceId: string): void;
}

export function clientWantsPaneOutput(
  client: GatewaySession,
  deviceId: string,
  paneId: string
): boolean {
  return (
    client.borshState.selectedPanes[deviceId] === paneId ||
    (client.borshState.subscribedPanes[deviceId]?.has(paneId) ?? false)
  );
}

function clientObservedPanes(client: GatewaySession, deviceId: string): Set<string> {
  const panes = new Set<string>();
  const selected = client.borshState.selectedPanes[deviceId];
  if (selected) panes.add(selected);
  const subscribed = client.borshState.subscribedPanes[deviceId];
  if (!subscribed) return panes;
  for (const paneId of subscribed) panes.add(paneId);
  return panes;
}

function observerKey(deviceId: string, paneId: string): string {
  return `${deviceId}\0${paneId}`;
}

export class LegacyFeedBroadcaster {
  private readonly legacyObserverCounts = new Map<string, number>();
  private readonly trackedObserverDevices = new Set<string>();
  private readonly clientLegacyObservers = new WeakMap<GatewaySession, Map<string, Set<string>>>();

  constructor(private readonly host: LegacyFeedHost) {}

  addLegacyPaneObserver(deviceId: string, paneId: string): void {
    this.trackedObserverDevices.add(deviceId);
    const key = observerKey(deviceId, paneId);
    this.legacyObserverCounts.set(key, (this.legacyObserverCounts.get(key) ?? 0) + 1);
  }

  removeLegacyPaneObserver(deviceId: string, paneId: string): void {
    this.trackedObserverDevices.add(deviceId);
    const key = observerKey(deviceId, paneId);
    const next = (this.legacyObserverCounts.get(key) ?? 0) - 1;
    if (next <= 0) this.legacyObserverCounts.delete(key);
    else this.legacyObserverCounts.set(key, next);
  }

  legacyPaneObserverCount(deviceId: string, paneId: string): number {
    return this.legacyObserverCounts.get(observerKey(deviceId, paneId)) ?? 0;
  }

  syncLegacyPaneObservers(client: GatewaySession, deviceId: string): void {
    const entry = this.host.connections.get(deviceId);
    const next = entry?.canonicalClients?.has(client)
      ? new Set<string>()
      : clientObservedPanes(client, deviceId);
    const byDevice = this.clientLegacyObservers.get(client) ?? new Map<string, Set<string>>();
    const previous = byDevice.get(deviceId) ?? new Set<string>();
    this.applyObserverDiff(deviceId, previous, next);
    byDevice.set(deviceId, next);
    this.clientLegacyObservers.set(client, byDevice);
  }

  releaseLegacyPaneObservers(client: GatewaySession, deviceId?: string): void {
    const byDevice = this.clientLegacyObservers.get(client);
    if (!byDevice) return;
    if (deviceId) {
      this.releaseClientDeviceObservers(client, byDevice, deviceId);
      return;
    }
    for (const id of [...byDevice.keys()]) {
      this.releaseClientDeviceObservers(client, byDevice, id);
    }
  }

  async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const extendedEvent = await this.extendTmuxEvent(deviceId, event);
    if (isEmptyNotification(extendedEvent.type, extendedEvent.data)) return;

    const payloadBytes = wsBorsh.encodeTmuxEventPayload({
      deviceId,
      type: extendedEvent.type,
      data: extendedEvent.data,
    });

    const settings = getSiteSettings();
    let attempts: number;
    if (extendedEvent.type === 'bell') {
      attempts = deliverBell(
        entry.clients,
        payloadBytes,
        deviceId,
        extendedEvent.data,
        settings.bellThrottleSeconds,
        this.host
      );
    } else if (extendedEvent.type === 'notification') {
      attempts = deliverNotification(
        entry.clients,
        payloadBytes,
        deviceId,
        extendedEvent.data,
        settings.notificationThrottleSeconds,
        this.host
      );
    } else {
      attempts = deliverGenericEvent(entry.clients, payloadBytes, this.host);
    }
    this.host.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, attempts);
  }

  async extendTmuxEvent(deviceId: string, event: TmuxEvent): Promise<TmuxEvent> {
    if (event.type !== 'bell' && event.type !== 'notification') {
      return event;
    }

    const settings = getSiteSettings();
    const snapshot = this.host.connections.get(deviceId)?.lastSnapshot ?? null;
    const paneContext = resolvePaneContext({
      deviceId,
      siteUrl: settings.siteUrl,
      snapshot,
      rawData: event.data,
    });

    if (event.type === 'bell') {
      return {
        type: 'bell',
        data: paneContext,
      };
    }

    const raw = (event.data as Record<string, unknown> | undefined) ?? {};
    const source =
      raw.source === 'osc9' ||
      raw.source === 'osc99' ||
      raw.source === 'osc777' ||
      raw.source === 'osc1337'
        ? raw.source
        : 'osc9';
    const title = typeof raw.title === 'string' && raw.title ? raw.title : undefined;
    const body = typeof raw.body === 'string' ? raw.body : '';

    return {
      type: 'notification',
      data: {
        ...paneContext,
        source,
        title,
        body,
      },
    };
  }

  broadcastStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    entry.lastSnapshot = payload;
    this.host.onStateSnapshotInstalled(deviceId);
    this.sendSnapshotToClients(entry, payload);
  }

  broadcastLegacyMetadataPatch(
    deviceId: string,
    patch: Parameters<typeof wsBorsh.sourceMetadataPatchToLegacyDiff>[0],
    currentSnapshot: StateSnapshotPayload | null
  ): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;
    const diff = wsBorsh.sourceMetadataPatchToLegacyDiff(patch);
    if (diff.upserts.length === 0 && diff.removals.length === 0) return;
    entry.lastSnapshot = currentSnapshot;
    const payload = wsBorsh.encodePayload(wsBorsh.schema.StateSnapshotDiffSchema, {
      deviceId,
      baseRevision: Number(patch.fromRevision & 0xffff_ffffn),
      revision: Number(patch.throughRevision & 0xffff_ffffn),
      diffFormat: wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON,
      diffBytes: wsBorsh.encodeLegacyStateSnapshotDiff(diff),
    });
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      this.host.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT_DIFF, payload);
    }
  }

  broadcastTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.host.connections.get(deviceId);
    const legacyObserved = this.isLegacyPaneObserved(deviceId, paneId, entry);
    const canonicalObserved = entry?.runtime?.isPaneTerminalRetained?.(paneId) ?? false;
    this.host.terminalOutputMetrics.recordSource(data.length, {
      legacy: legacyObserved,
      canonical: canonicalObserved,
    });
    this.host.terminalOutputEventsUntilMetricsCheck -= 1;
    if (this.host.terminalOutputEventsUntilMetricsCheck === 0) {
      this.host.terminalOutputEventsUntilMetricsCheck = 1024;
      this.host.reportTerminalOutputMetricsIfDue();
    }
    if (!legacyObserved) return;
    this.host.terminalOutputBatcher.push(deviceId, paneId, data);
  }

  sendSnapshotToClients(
    entry: DeviceConnectionEntry,
    payload: StateSnapshotPayload,
    options: { includeCanonical?: boolean } = {}
  ): void {
    const payloadBytes = this.host.encodeSnapshotWithOverlays(payload);
    let deliveries = 0;
    for (const client of entry.clients) {
      if (!options.includeCanonical && entry.canonicalClients?.has(client)) continue;
      if (this.host.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT, payloadBytes)) {
        deliveries += 1;
      }
    }
    this.host.gatewayActivityMetrics.recordSnapshot(payloadBytes.length, deliveries);
  }

  sendTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const frameCache = entry.clients.size > 1 ? new Map<number, Uint8Array>() : null;
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      const isFocused = client.borshState.selectedPanes[deviceId] === paneId;
      if (!clientWantsPaneOutput(client, deviceId, paneId)) {
        continue;
      }

      if (isFocused && switchBarrier.shouldBufferOutput(client, deviceId)) {
        switchBarrier.bufferOutput(client, deviceId, data);
        continue;
      }

      const payloadBytes = this.host.sendTermOutput(client, deviceId, paneId, data, frameCache);
      if (payloadBytes !== null) this.host.terminalOutputMetrics.recordRecipient(payloadBytes);
    }
  }

  broadcastClipboardWrite(deviceId: string, paneId: string, text: string): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, {
      deviceId,
      paneId,
      text,
    });

    for (const client of entry.clients) {
      if (
        !entry.canonicalClients?.has(client) &&
        client.borshState.selectedPanes[deviceId] !== paneId
      ) {
        continue;
      }
      this.host.sendEnvelope(client, wsBorsh.KIND_CLIPBOARD_WRITE, payloadBytes);
    }
  }

  broadcastTerminalHistory(
    deviceId: string,
    paneId: string,
    data: string,
    alternateScreen: boolean,
    modes: number
  ): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const historyBytes = new TextEncoder().encode(data);
    let deliveryAttempts = 0;

    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      const txPaneId = switchBarrier.getTransactionPaneId(client, deviceId);
      if (txPaneId !== null && txPaneId === paneId) {
        switchBarrier.sendTermHistory(
          client,
          deviceId,
          paneId,
          historyBytes,
          alternateScreen,
          modes
        );
        deliveryAttempts += 1;
        continue;
      }

      if (client.borshState.selectedPanes[deviceId] === paneId) {
        switchBarrier.sendTermHistory(
          client,
          deviceId,
          paneId,
          historyBytes,
          alternateScreen,
          modes
        );
        deliveryAttempts += 1;
      }
    }
    this.host.gatewayActivityMetrics.recordTerminalHistory(historyBytes.length, deliveryAttempts);
  }

  broadcastError(deviceId: string, err: Error): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const errorInfo = classifySshError(err);

    const payloadBytes = wsBorsh.encodeDeviceEventPayload({
      deviceId,
      type: 'error',
      errorType: errorInfo.type,
      message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
      rawMessage: err.message,
    });

    for (const client of entry.clients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  broadcastDeviceError(deviceId: string, payload: EventDevicePayload): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const payloadBytes = wsBorsh.encodeDeviceEventPayload(payload);
    for (const client of entry.clients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void {
    const payloadBytes = wsBorsh.encodeDeviceEventPayload(payload);

    for (const client of entry.clients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_DEVICE_EVENT, payloadBytes);
    }
  }

  private isLegacyPaneObserved(
    deviceId: string,
    paneId: string,
    entry: DeviceConnectionEntry | undefined
  ): boolean {
    if (!entry) return false;
    if (this.legacyPaneObserverCount(deviceId, paneId) > 0) return true;
    if (this.trackedObserverDevices.has(deviceId)) return false;
    return this.scanLegacyPaneObservers(entry, deviceId, paneId);
  }

  private scanLegacyPaneObservers(
    entry: DeviceConnectionEntry,
    deviceId: string,
    paneId: string
  ): boolean {
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      if (clientWantsPaneOutput(client, deviceId, paneId)) return true;
    }
    return false;
  }

  private applyObserverDiff(deviceId: string, previous: Set<string>, next: Set<string>): void {
    for (const paneId of previous) {
      if (!next.has(paneId)) this.removeLegacyPaneObserver(deviceId, paneId);
    }
    for (const paneId of next) {
      if (!previous.has(paneId)) this.addLegacyPaneObserver(deviceId, paneId);
    }
  }

  private releaseClientDeviceObservers(
    client: GatewaySession,
    byDevice: Map<string, Set<string>>,
    deviceId: string
  ): void {
    const panes = byDevice.get(deviceId);
    if (!panes) return;
    this.applyObserverDiff(deviceId, panes, new Set());
    byDevice.delete(deviceId);
    if (byDevice.size === 0) this.clientLegacyObservers.delete(client);
  }
}
