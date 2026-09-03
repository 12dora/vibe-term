import type { EventDevicePayload, StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import type { TmuxEvent } from '../tmux-client/events';
import { resolvePaneContext } from '../tmux/bell-context';
import { classifySshError } from './error-classify';
import {
  deliverBell,
  deliverGenericEvent,
  deliverNotification,
  isEmptyNotification,
} from './event-delivery';
import type { GatewayActivityMetrics } from './gateway-activity-metrics';
import type { GatewaySession } from './gateway-session';
import {
  TERMINAL_OUTPUT_METRICS_CHECK_EVERY,
  type TerminalOutputMetrics,
} from './terminal-output-metrics';
import type { DeviceConnectionEntry } from './types';

export interface DeviceFeedHost {
  readonly connections: Map<string, DeviceConnectionEntry>;
  readonly terminalOutputMetrics: TerminalOutputMetrics;
  readonly gatewayActivityMetrics: GatewayActivityMetrics;
  terminalOutputEventsUntilMetricsCheck: number;
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
  reportTerminalOutputMetricsIfDue(): void;
  onStateSnapshotInstalled(deviceId: string): void;
}

/**
 * 设备侧非终端流的广播：tmux 事件、剪贴板、设备错误。
 * 终端内容（屏幕/历史/增量）只走 canonical 流，不在这里。
 */
export class DeviceFeedBroadcaster {
  constructor(private readonly host: DeviceFeedHost) {}

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

  /** 快照只作为网关内部状态（视口策略、bell 上下文、选择校验）落地，不再下发给客户端。 */
  installStateSnapshot(deviceId: string, payload: StateSnapshotPayload): void {
    const entry = this.host.connections.get(deviceId);
    if (!entry) return;

    entry.lastSnapshot = payload;
    this.host.onStateSnapshotInstalled(deviceId);
  }

  noteTerminalOutput(deviceId: string, paneId: string, data: Uint8Array): void {
    const entry = this.host.connections.get(deviceId);
    const canonicalObserved = entry?.runtime?.isPaneTerminalRetained?.(paneId) ?? false;
    this.host.terminalOutputMetrics.recordSource(data.length, { canonical: canonicalObserved });
    this.host.terminalOutputEventsUntilMetricsCheck -= 1;
    if (
      this.host.terminalOutputEventsUntilMetricsCheck <= 0 ||
      this.host.terminalOutputMetrics.isDue(Date.now())
    ) {
      this.host.terminalOutputEventsUntilMetricsCheck = TERMINAL_OUTPUT_METRICS_CHECK_EVERY;
      this.host.reportTerminalOutputMetricsIfDue();
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
      this.host.sendEnvelope(client, wsBorsh.KIND_CLIPBOARD_WRITE, payloadBytes);
    }
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
