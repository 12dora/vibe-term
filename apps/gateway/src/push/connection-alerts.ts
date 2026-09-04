import type {
  Device,
  EventDevicePayload,
  EventType,
  SiteSettings,
  WebhookEvent,
} from '@tmex/shared';
import { getSiteSettings, updateDeviceRuntimeStatus } from '../db';
import { DEVICE_CONNECTION_ERROR_EVENT } from '../events/channels/types';
import { t } from '../i18n';
import { classifySshError } from '../ws/error-classify';
import {
  buildConnectionBridgeEvent,
  isWithinThrottleWindow,
  resolveConnectionBridgeEvent,
  sweepExpiredThrottleKeys,
} from './connection-bridge';

export type ConnectionAlertSource = 'connect' | 'runtime' | 'close' | 'probe';

export type ConnectionEventEmitter = (
  eventType: EventType,
  event: Omit<WebhookEvent, 'eventType' | 'timestamp'>
) => void | Promise<void>;

export interface ConnectionAlertInput {
  device: Device;
  error: unknown;
  source: ConnectionAlertSource;
  silentTelegram?: boolean;
  persist?: boolean;
  // 本次断开前连接已因 session gone 发出 session_closed（同一物理事件不再发 device_disconnect）。
  // 由持有连接实例的调用方显式传入；持久化的 tmuxAvailable 状态位被大量无关路径写入，不可作此信号。
  sessionClosedEmitted?: boolean;
}

export interface ClassifiedConnectionAlert {
  errorType: string;
  messageKey: string;
  message: string;
  rawMessage: string;
}

export type ConnectionAlertBroadcaster = (deviceId: string, payload: EventDevicePayload) => void;

const NOTIFY_THROTTLE_MS = 5 * 60 * 1000;

function toErrorObject(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  if (typeof err === 'string') {
    return new Error(err);
  }
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

export class ConnectionAlertNotifier {
  private readonly throttleMap = new Map<string, number>();
  private readonly bridgeThrottleMap = new Map<string, number>();
  private broadcaster: ConnectionAlertBroadcaster | null = null;
  private eventEmitter: ConnectionEventEmitter | null = null;
  private settingsProvider: () => SiteSettings = () => getSiteSettings();
  private persister: (deviceId: string, friendlyMessage: string, errorType: string) => void = (
    deviceId,
    friendlyMessage,
    errorType
  ) => {
    updateDeviceRuntimeStatus(deviceId, {
      lastSeenAt: new Date().toISOString(),
      lastError: friendlyMessage,
      lastErrorType: errorType,
    });
  };

  setBroadcaster(broadcaster: ConnectionAlertBroadcaster | null): void {
    this.broadcaster = broadcaster;
  }

  setEventEmitter(emitter: ConnectionEventEmitter | null): void {
    this.eventEmitter = emitter;
  }

  setSettingsProvider(provider: () => SiteSettings): void {
    this.settingsProvider = provider;
  }

  setPersister(
    persister: (deviceId: string, friendlyMessage: string, errorType: string) => void
  ): void {
    this.persister = persister;
  }

  /** 连接错误已改走 EventNotifier；保留该方法以免调用方编译失败。 */
  setTelegramSender(_sender: (text: string) => Promise<void>): void {}

  async notify(alert: ConnectionAlertInput): Promise<ClassifiedConnectionAlert> {
    const {
      device,
      error,
      source,
      silentTelegram = false,
      persist = true,
      sessionClosedEmitted = false,
    } = alert;
    const errObj = toErrorObject(error);
    const classified = classifySshError(errObj);
    const friendlyMessage = t(classified.messageKey, { ...classified.messageParams });
    const rawMessage = errObj.message;
    // 持久化时把真实错误一并保留，避免设备页只看到归类后的兜底文案（刷新后 raw 不丢）；
    // unknown 类的友好文案模板已内嵌 raw（"Connection failed: {{message}}"），用 includes 去重避免重复拼接
    const persistedMessage =
      rawMessage && !friendlyMessage.includes(rawMessage)
        ? `${friendlyMessage}\n${rawMessage}`
        : friendlyMessage;

    console.error(
      `[conn-alert] device ${device.id} (${device.name}) source=${source} type=${classified.type}: ${rawMessage}`
    );

    if (persist) {
      try {
        this.persister(device.id, persistedMessage, classified.type);
      } catch (dbErr) {
        console.error('[conn-alert] failed to persist runtime status:', dbErr);
      }
    }

    if (this.broadcaster) {
      try {
        this.broadcaster(device.id, {
          deviceId: device.id,
          type: 'error',
          errorType: classified.type,
          message: friendlyMessage,
          rawMessage,
        });
      } catch (broadcastErr) {
        console.error('[conn-alert] failed to broadcast:', broadcastErr);
      }
    }

    if (!silentTelegram && this.shouldNotifyPush(device.id, classified.type)) {
      await this.emitConnectionError(device, classified.type, friendlyMessage, rawMessage);
    }

    await this.maybeEmitEvent(
      device,
      source,
      classified.type,
      friendlyMessage,
      sessionClosedEmitted
    );

    return {
      errorType: classified.type,
      messageKey: classified.messageKey,
      message: friendlyMessage,
      rawMessage,
    };
  }

  clear(deviceId: string): void {
    for (const key of this.throttleMap.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.throttleMap.delete(key);
      }
    }
    for (const key of this.bridgeThrottleMap.keys()) {
      if (key.startsWith(`${deviceId}:`)) {
        this.bridgeThrottleMap.delete(key);
      }
    }
  }

  private async maybeEmitEvent(
    device: Device,
    source: ConnectionAlertSource,
    errorType: string,
    friendlyMessage: string,
    sessionClosedEmitted: boolean
  ): Promise<void> {
    if (!this.eventEmitter) return;
    const eventType = resolveConnectionBridgeEvent(source, errorType, sessionClosedEmitted);
    if (!eventType) return;

    const now = Date.now();
    const key = `${device.id}:${eventType}`;
    if (isWithinThrottleWindow(this.bridgeThrottleMap.get(key), now, NOTIFY_THROTTLE_MS)) {
      return;
    }

    let settings: SiteSettings;
    try {
      settings = this.settingsProvider();
    } catch {
      return;
    }
    try {
      await this.eventEmitter(
        eventType,
        buildConnectionBridgeEvent(device, settings, friendlyMessage)
      );
    } catch (emitErr) {
      console.error('[conn-alert] event emit failed:', emitErr);
      return;
    }
    this.bridgeThrottleMap.set(key, now);
    sweepExpiredThrottleKeys(this.bridgeThrottleMap, device.id, key, now, NOTIFY_THROTTLE_MS);
  }

  private shouldNotifyPush(deviceId: string, errorType: string): boolean {
    const key = `${deviceId}:${errorType}`;
    const now = Date.now();
    const last = this.throttleMap.get(key) ?? 0;
    if (now - last < NOTIFY_THROTTLE_MS) {
      return false;
    }
    this.throttleMap.set(key, now);
    for (const [otherKey, ts] of this.throttleMap) {
      if (
        otherKey !== key &&
        otherKey.startsWith(`${deviceId}:`) &&
        now - ts >= NOTIFY_THROTTLE_MS
      ) {
        this.throttleMap.delete(otherKey);
      }
    }
    return true;
  }

  private async emitConnectionError(
    device: Device,
    errorType: string,
    friendlyMessage: string,
    rawMessage: string
  ): Promise<void> {
    if (!this.eventEmitter) return;
    let settings: SiteSettings;
    try {
      settings = this.settingsProvider();
    } catch (err) {
      console.error('[conn-alert] failed to read site settings:', err);
      return;
    }

    const categoryKey = `deviceStatus.errorBadge.${toBadgeKey(errorType)}`;
    const category = t(categoryKey, { defaultValue: errorType });
    try {
      await this.eventEmitter(DEVICE_CONNECTION_ERROR_EVENT, {
        site: { name: settings.siteName, url: settings.siteUrl },
        device: { id: device.id, name: device.name, type: device.type, host: device.host },
        tmux: { sessionName: device.session?.trim() || 'tmex' },
        payload: {
          message: friendlyMessage || rawMessage,
          errorType,
          category,
          rawMessage,
        },
      });
    } catch (notifyErr) {
      console.error('[conn-alert] connection error notify failed:', notifyErr);
    }
  }
}

function toBadgeKey(errorType: string): string {
  switch (errorType) {
    case 'auth_failed':
      return 'authFailed';
    case 'agent_unavailable':
      return 'agentUnavailable';
    case 'agent_no_identity':
      return 'agentNoIdentity';
    case 'ssh_config_ref_not_supported':
      return 'configRefNotSupported';
    case 'network_unreachable':
      return 'networkUnreachable';
    case 'connection_refused':
      return 'connectionRefused';
    case 'timeout':
      return 'timeout';
    case 'host_not_found':
      return 'hostNotFound';
    case 'handshake_failed':
      return 'handshakeFailed';
    case 'tmux_unavailable':
      return 'tmuxUnavailable';
    case 'connection_closed':
      return 'connectionClosed';
    default:
      return 'unknown';
  }
}

export const connectionAlertNotifier = new ConnectionAlertNotifier();
