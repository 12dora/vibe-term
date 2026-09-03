// WebSocket Borsh 协议 wire <-> domain 转换层
// 参考: docs/ws-protocol/2026021402-ws-borsh-v1-spec.md

import type { b } from '@zorsh/zorsh';
import type {
  DeviceEventType,
  NotificationSource,
  TmuxBellEventData,
  TmuxEventType,
  TmuxNotificationEventData,
} from '../contracts/tmux';
import type { EventDevicePayload, EventTmuxPayload } from '../contracts/websocket';
import * as schema from './schema';

function invertTagMap<T extends string>(tags: Record<T, number>): Record<number, T> {
  const inverted: Record<number, T> = {};
  for (const key of Object.keys(tags) as T[]) {
    inverted[tags[key]] = key;
  }
  return inverted;
}

const NOTIFICATION_SOURCE_TAGS: Record<NotificationSource, number> = {
  osc9: 1,
  osc777: 2,
  osc1337: 3,
  osc99: 4,
};

const NOTIFICATION_SOURCE_BY_TAG = invertTagMap(NOTIFICATION_SOURCE_TAGS);

const DEVICE_EVENT_TAGS: Record<DeviceEventType, number> = {
  'tmux-missing': 1,
  disconnected: 2,
  error: 3,
  reconnected: 4,
};

const DEVICE_EVENT_TYPE_BY_TAG = invertTagMap(DEVICE_EVENT_TAGS);

// ========== tmux 事件 codec 表 ==========
//
// 新增一种 tmux 事件时只改这张表：tag 是 wire 上的 u8 判别值，
// encode/decode 负责 domain <-> wire 的字段映射（null <-> undefined）。

interface TmuxEventCodec {
  tag: number;
  encode: (data: unknown) => Uint8Array;
  decode: (bytes: Uint8Array) => unknown;
}

function defineTmuxEventCodec<TData>(spec: {
  tag: number;
  encode: (data: TData) => Uint8Array;
  decode: (bytes: Uint8Array) => unknown;
}): TmuxEventCodec {
  return {
    tag: spec.tag,
    encode: (data) => spec.encode(data as TData),
    decode: spec.decode,
  };
}

const TMUX_EVENT_CODECS: Record<TmuxEventType, TmuxEventCodec> = {
  'window-add': defineTmuxEventCodec({
    tag: 1,
    encode: (data: { windowId: string }) =>
      schema.WindowAddEventSchema.serialize({ windowId: data.windowId }),
    decode: (bytes) => schema.WindowAddEventSchema.deserialize(bytes),
  }),
  'window-close': defineTmuxEventCodec({
    tag: 2,
    encode: (data: { windowId: string }) =>
      schema.WindowCloseEventSchema.serialize({ windowId: data.windowId }),
    decode: (bytes) => schema.WindowCloseEventSchema.deserialize(bytes),
  }),
  'window-renamed': defineTmuxEventCodec({
    tag: 3,
    encode: (data: { windowId: string; name: string }) =>
      schema.WindowRenamedEventSchema.serialize({
        windowId: data.windowId,
        name: data.name,
      }),
    decode: (bytes) => schema.WindowRenamedEventSchema.deserialize(bytes),
  }),
  'window-active': defineTmuxEventCodec({
    tag: 4,
    encode: (data: { windowId: string }) =>
      schema.WindowActiveEventSchema.serialize({ windowId: data.windowId }),
    decode: (bytes) => schema.WindowActiveEventSchema.deserialize(bytes),
  }),
  'pane-add': defineTmuxEventCodec({
    tag: 5,
    encode: (data: { paneId: string; windowId: string }) =>
      schema.PaneAddEventSchema.serialize({
        paneId: data.paneId,
        windowId: data.windowId,
      }),
    decode: (bytes) => schema.PaneAddEventSchema.deserialize(bytes),
  }),
  'pane-close': defineTmuxEventCodec({
    tag: 6,
    encode: (data: { paneId: string }) =>
      schema.PaneCloseEventSchema.serialize({ paneId: data.paneId }),
    decode: (bytes) => schema.PaneCloseEventSchema.deserialize(bytes),
  }),
  'pane-active': defineTmuxEventCodec({
    tag: 7,
    encode: (data: { windowId: string; paneId: string }) =>
      schema.PaneActiveEventSchema.serialize({
        windowId: data.windowId,
        paneId: data.paneId,
      }),
    decode: (bytes) => schema.PaneActiveEventSchema.deserialize(bytes),
  }),
  'layout-change': defineTmuxEventCodec({
    tag: 8,
    encode: (data: { windowId: string; layout: string }) =>
      schema.LayoutChangeEventSchema.serialize({
        windowId: data.windowId,
        layout: data.layout,
      }),
    decode: (bytes) => schema.LayoutChangeEventSchema.deserialize(bytes),
  }),
  bell: defineTmuxEventCodec({
    tag: 9,
    encode: (data: TmuxBellEventData) =>
      schema.BellEventSchema.serialize({
        windowId: data.windowId ?? null,
        paneId: data.paneId ?? null,
        windowIndex: data.windowIndex ?? null,
        paneIndex: data.paneIndex ?? null,
        paneUrl: data.paneUrl ?? null,
        paneTitle: data.paneTitle ?? null,
        paneCurrentCommand: data.paneCurrentCommand ?? null,
      }),
    decode: (bytes) => {
      const bell = schema.BellEventSchema.deserialize(bytes);
      return {
        windowId: bell.windowId ?? undefined,
        paneId: bell.paneId ?? undefined,
        windowIndex: bell.windowIndex ?? undefined,
        paneIndex: bell.paneIndex ?? undefined,
        paneUrl: bell.paneUrl ?? undefined,
        paneTitle: bell.paneTitle ?? undefined,
        paneCurrentCommand: bell.paneCurrentCommand ?? undefined,
      } satisfies TmuxBellEventData;
    },
  }),
  output: defineTmuxEventCodec({
    tag: 10,
    encode: () => new Uint8Array(),
    decode: () => ({}),
  }),
  notification: defineTmuxEventCodec({
    tag: 11,
    encode: (data: TmuxNotificationEventData) =>
      schema.NotificationEventSchema.serialize({
        source: NOTIFICATION_SOURCE_TAGS[data.source],
        title: data.title ?? null,
        body: data.body,
        windowId: data.windowId ?? null,
        paneId: data.paneId ?? null,
        windowIndex: data.windowIndex ?? null,
        paneIndex: data.paneIndex ?? null,
        paneUrl: data.paneUrl ?? null,
        paneTitle: data.paneTitle ?? null,
        paneCurrentCommand: data.paneCurrentCommand ?? null,
      }),
    decode: (bytes) => {
      const notification = schema.NotificationEventSchema.deserialize(bytes);
      return {
        source: NOTIFICATION_SOURCE_BY_TAG[notification.source] ?? 'osc9',
        title: notification.title ?? undefined,
        body: notification.body,
        windowId: notification.windowId ?? undefined,
        paneId: notification.paneId ?? undefined,
        windowIndex: notification.windowIndex ?? undefined,
        paneIndex: notification.paneIndex ?? undefined,
        paneUrl: notification.paneUrl ?? undefined,
        paneTitle: notification.paneTitle ?? undefined,
        paneCurrentCommand: notification.paneCurrentCommand ?? undefined,
      } satisfies TmuxNotificationEventData;
    },
  }),
};

const TMUX_EVENT_TYPE_BY_TAG: Record<number, TmuxEventType> = Object.fromEntries(
  (Object.keys(TMUX_EVENT_CODECS) as TmuxEventType[]).map((type) => [
    TMUX_EVENT_CODECS[type].tag,
    type,
  ])
);

// ========== Domain -> Wire 编码 ==========

export function encodeDeviceEventPayload(payload: EventDevicePayload): Uint8Array {
  const wireData: b.infer<typeof schema.DeviceEventSchema> = {
    deviceId: payload.deviceId,
    eventType: DEVICE_EVENT_TAGS[payload.type],
    errorType: payload.errorType ?? null,
    message: payload.message ?? null,
    rawMessage: payload.rawMessage ?? null,
  };

  return schema.DeviceEventSchema.serialize(wireData);
}

export function encodeTmuxEventPayload(payload: EventTmuxPayload): Uint8Array {
  const eventData = encodeEventData(payload.type, payload.data);

  const wireData: b.infer<typeof schema.TmuxEventSchema> = {
    deviceId: payload.deviceId,
    eventType: TMUX_EVENT_CODECS[payload.type].tag,
    eventData,
  };

  return schema.TmuxEventSchema.serialize(wireData);
}

function encodeEventData(type: TmuxEventType, data: unknown): Uint8Array {
  const codec = TMUX_EVENT_CODECS[type];
  if (!codec) return new Uint8Array();
  return codec.encode(data);
}

// ========== Wire -> Domain 解码 ==========

export function decodeDeviceEventPayload(data: Uint8Array): EventDevicePayload {
  const wire = schema.DeviceEventSchema.deserialize(data);

  return {
    deviceId: wire.deviceId,
    type: DEVICE_EVENT_TYPE_BY_TAG[wire.eventType] ?? 'error',
    errorType: wire.errorType ?? undefined,
    message: wire.message ?? undefined,
    rawMessage: wire.rawMessage ?? undefined,
  };
}

export function decodeTmuxEventPayload(data: Uint8Array): EventTmuxPayload {
  const wire = schema.TmuxEventSchema.deserialize(data);

  const type = TMUX_EVENT_TYPE_BY_TAG[wire.eventType];
  if (!type) {
    throw new Error(`Unknown tmux event type: ${wire.eventType}`);
  }

  return {
    deviceId: wire.deviceId,
    type,
    data: decodeEventData(type, wire.eventData),
  };
}

function decodeEventData(type: TmuxEventType, data: Uint8Array): unknown {
  if (data.length === 0) return {};

  const codec = TMUX_EVENT_CODECS[type];
  if (!codec) return {};

  try {
    return codec.decode(data);
  } catch {
    return {};
  }
}
