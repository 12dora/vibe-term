import type { EventDevicePayload, StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import type { TmuxEvent } from '../tmux-client/events';
import { resolvePaneContext } from '../tmux/bell-context';
import { sessionStateStore } from './borsh/session-state';
import { switchBarrier } from './borsh/switch-barrier';
import { classifySshError } from './error-classify';
import type { GatewayActivityMetrics } from './gateway-activity-metrics';
import type { TerminalOutputBatcher } from './terminal-output-batcher';
import type { TerminalOutputMetrics } from './terminal-output-metrics';
import type { ClientState, DeviceConnectionEntry } from './types';

export interface LegacyFeedHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly terminalOutputBatcher: TerminalOutputBatcher;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  readonly gatewayActivityMetrics: GatewayActivityMetrics;
  terminalOutputEventsUntilMetricsCheck: number;
  sendEnvelope(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): void;
  sendChunked(ws: ServerWebSocket<ClientState>, kind: number, payload: Uint8Array): boolean;
  encodeSnapshotWithOverlays(payload: StateSnapshotPayload): Uint8Array;
  reportTerminalOutputMetricsIfDue(): void;
}

export function clientWantsPaneOutput(
  client: ServerWebSocket<ClientState>,
  deviceId: string,
  paneId: string
): boolean {
  return (
    client.data.borshState.selectedPanes[deviceId] === paneId ||
    (client.data.borshState.subscribedPanes[deviceId]?.has(paneId) ?? false)
  );
}

export class LegacyFeedBroadcaster {
  constructor(private readonly host: LegacyFeedHost) {}

  async broadcastTmuxEvent(deviceId: string, event: TmuxEvent): Promise<void> {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    const extendedEvent = await this.extendTmuxEvent(deviceId, event);
    const settings = getSiteSettings();

    if (extendedEvent.type === 'notification') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const title = typeof data.title === 'string' && data.title ? data.title : '';
      const body = typeof data.body === 'string' ? data.body : '';
      if (!title && !body) {
        return;
      }
    }

    const payloadBytes = wsBorsh.encodeTmuxEventPayload({
      deviceId,
      type: extendedEvent.type,
      data: extendedEvent.data,
    });

    if (extendedEvent.type === 'bell') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const paneId = typeof data.paneId === 'string' && data.paneId ? data.paneId : '-';

      let deliveryAttempts = 0;
      for (const client of entry.clients) {
        if (
          !sessionStateStore.shouldAllowBell(client, deviceId, paneId, settings.bellThrottleSeconds)
        ) {
          continue;
        }
        this.host.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
        deliveryAttempts += 1;
      }
      this.host.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, deliveryAttempts);
      return;
    }

    if (extendedEvent.type === 'notification') {
      const data = (extendedEvent.data ?? {}) as Record<string, unknown>;
      const paneId = typeof data.paneId === 'string' && data.paneId ? data.paneId : '-';
      const source = typeof data.source === 'string' && data.source ? data.source : 'osc9';

      let deliveryAttempts = 0;
      for (const client of entry.clients) {
        if (
          !sessionStateStore.shouldAllowNotification(
            client,
            deviceId,
            paneId,
            source,
            settings.notificationThrottleSeconds
          )
        ) {
          continue;
        }
        this.host.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
        deliveryAttempts += 1;
      }
      this.host.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, deliveryAttempts);
      return;
    }

    for (const client of entry.clients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_TMUX_EVENT, payloadBytes);
    }
    this.host.gatewayActivityMetrics.recordTmuxEvent(extendedEvent.type, entry.clients.size);
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
    let legacyObserved = false;
    if (entry) {
      for (const client of entry.clients) {
        if (entry.canonicalClients?.has(client)) continue;
        if (clientWantsPaneOutput(client, deviceId, paneId)) {
          legacyObserved = true;
          break;
        }
      }
    }
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
    if (!legacyObserved) {
      return;
    }
    this.host.terminalOutputBatcher.push(deviceId, paneId, data);
  }

  sendSnapshotToClients(entry: DeviceConnectionEntry, payload: StateSnapshotPayload): void {
    const payloadBytes = this.host.encodeSnapshotWithOverlays(payload);
    let deliveries = 0;
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      if (this.host.sendChunked(client, wsBorsh.KIND_STATE_SNAPSHOT, payloadBytes)) {
        deliveries += 1;
      }
    }
    this.host.gatewayActivityMetrics.recordSnapshot(payloadBytes.length, deliveries);
  }

  sendTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    let payloadBytes: Uint8Array | null = null;
    for (const client of entry.clients) {
      if (entry.canonicalClients?.has(client)) continue;
      const isFocused = client.data.borshState.selectedPanes[deviceId] === paneId;
      if (!clientWantsPaneOutput(client, deviceId, paneId)) {
        continue;
      }

      if (isFocused && switchBarrier.shouldBufferOutput(client, deviceId)) {
        switchBarrier.bufferOutput(client, deviceId, data);
        continue;
      }

      payloadBytes ??= wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, {
        deviceId,
        paneId,
        encoding: 1,
        data,
      });
      if (this.host.sendChunked(client, wsBorsh.KIND_TERM_OUTPUT, payloadBytes)) {
        this.host.terminalOutputMetrics.recordRecipient(payloadBytes.length);
      }
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
        client.data.borshState.selectedPanes[deviceId] !== paneId
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
      const txPaneId = switchBarrier.getTransactionPaneId(client as never, deviceId);
      if (txPaneId !== null && txPaneId === paneId) {
        switchBarrier.sendTermHistory(
          client as never,
          deviceId,
          paneId,
          historyBytes,
          alternateScreen,
          modes
        );
        deliveryAttempts += 1;
        continue;
      }

      if (client.data.borshState.selectedPanes[deviceId] === paneId) {
        switchBarrier.sendTermHistory(
          client as never,
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
}
