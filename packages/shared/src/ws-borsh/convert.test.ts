// WebSocket Borsh 转换层单元测试

import { describe, expect, it } from 'bun:test';
import type { EventDevicePayload, EventTmuxPayload } from '../index';
import {
  decodeDeviceEventPayload,
  decodeTmuxEventPayload,
  encodeDeviceEventPayload,
  encodeTmuxEventPayload,
} from './convert';
import * as schema from './schema';

describe('convert', () => {
  describe('DeviceEvent', () => {
    it('应该正确编解码 device error 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'error',
        errorType: 'connection_failed',
        message: 'Connection failed',
        rawMessage: 'Raw error message',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe(payload.type);
      expect(decoded.errorType).toBe(payload.errorType);
      expect(decoded.message).toBe(payload.message);
      expect(decoded.rawMessage).toBe(payload.rawMessage);
    });

    it('应该正确编解码 device disconnected 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'disconnected',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('disconnected');
    });

    it('应该正确编解码 device reconnected 事件', () => {
      const payload: EventDevicePayload = {
        deviceId: 'device-1',
        type: 'reconnected',
      };

      const encoded = encodeDeviceEventPayload(payload);
      const decoded = decodeDeviceEventPayload(encoded);

      expect(decoded.deviceId).toBe(payload.deviceId);
      expect(decoded.type).toBe('reconnected');
    });
  });

  // 各事件类型的 round-trip 与 wire tag 覆盖见下方「tmux event codec 表」
  describe('TmuxEvent', () => {
    it('bell 事件无 paneTitle/paneCurrentCommand 时解码为 undefined', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'bell',
        data: {
          windowId: '@1',
          paneId: '%2',
          windowIndex: 0,
          paneIndex: 1,
        },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      const data = decoded.data as Record<string, unknown>;
      expect(data.paneTitle).toBeUndefined();
      expect(data.paneCurrentCommand).toBeUndefined();
      expect(data.windowId).toBe('@1');
      expect(data.paneId).toBe('%2');
    });

    it('notification 事件无 paneTitle/paneCurrentCommand 时解码为 undefined', () => {
      const payload: EventTmuxPayload = {
        deviceId: 'device-1',
        type: 'notification',
        data: {
          source: 'osc9',
          title: 'Alert',
          body: 'Something happened',
          windowId: '@1',
          paneId: '%2',
          windowIndex: 0,
          paneIndex: 1,
        },
      };

      const encoded = encodeTmuxEventPayload(payload);
      const decoded = decodeTmuxEventPayload(encoded);

      const data = decoded.data as Record<string, unknown>;
      expect(data.paneTitle).toBeUndefined();
      expect(data.paneCurrentCommand).toBeUndefined();
      expect(data.source).toBe('osc9');
      expect(data.body).toBe('Something happened');
    });

    it('遇到未知 tmux event tag 时应该抛错而不是回退为 output', () => {
      const encoded = schema.TmuxEventSchema.serialize({
        deviceId: 'device-1',
        eventType: 255,
        eventData: new Uint8Array(),
      });

      expect(() => decodeTmuxEventPayload(encoded)).toThrow('Unknown tmux event type: 255');
    });
  });
});

// codec 表覆盖：每种 tmux 事件都要能 round-trip，且 wire tag 不允许漂移
describe('tmux event codec 表', () => {
  const cases: Array<{
    type: EventTmuxPayload['type'];
    tag: number;
    data: unknown;
    decoded: unknown;
  }> = [
    { type: 'window-add', tag: 1, data: { windowId: '@1' }, decoded: { windowId: '@1' } },
    { type: 'window-close', tag: 2, data: { windowId: '@2' }, decoded: { windowId: '@2' } },
    {
      type: 'window-renamed',
      tag: 3,
      data: { windowId: '@3', name: 'renamed' },
      decoded: { windowId: '@3', name: 'renamed' },
    },
    { type: 'window-active', tag: 4, data: { windowId: '@4' }, decoded: { windowId: '@4' } },
    {
      type: 'pane-add',
      tag: 5,
      data: { paneId: '%5', windowId: '@5' },
      decoded: { paneId: '%5', windowId: '@5' },
    },
    { type: 'pane-close', tag: 6, data: { paneId: '%6' }, decoded: { paneId: '%6' } },
    {
      type: 'pane-active',
      tag: 7,
      data: { windowId: '@7', paneId: '%7' },
      decoded: { windowId: '@7', paneId: '%7' },
    },
    {
      type: 'layout-change',
      tag: 8,
      data: { windowId: '@8', layout: 'abcd,80x24,0,0,0' },
      decoded: { windowId: '@8', layout: 'abcd,80x24,0,0,0' },
    },
    {
      type: 'bell',
      tag: 9,
      data: {
        windowId: '@9',
        paneId: '%9',
        windowIndex: 9,
        paneIndex: 90,
        paneUrl: 'https://example.com/bell',
        paneTitle: 'bell pane',
        paneCurrentCommand: 'sleep',
      },
      decoded: {
        windowId: '@9',
        paneId: '%9',
        windowIndex: 9,
        paneIndex: 90,
        paneUrl: 'https://example.com/bell',
        paneTitle: 'bell pane',
        paneCurrentCommand: 'sleep',
      },
    },
    { type: 'output', tag: 10, data: {}, decoded: {} },
    {
      type: 'notification',
      tag: 11,
      data: {
        source: 'osc1337',
        title: 'Deploy',
        body: 'done',
        windowId: '@11',
        paneId: '%11',
        windowIndex: 11,
        paneIndex: 110,
        paneUrl: 'https://example.com/deploy',
        paneTitle: 'deploy pane',
        paneCurrentCommand: 'bun',
      },
      decoded: {
        source: 'osc1337',
        title: 'Deploy',
        body: 'done',
        windowId: '@11',
        paneId: '%11',
        windowIndex: 11,
        paneIndex: 110,
        paneUrl: 'https://example.com/deploy',
        paneTitle: 'deploy pane',
        paneCurrentCommand: 'bun',
      },
    },
  ];

  for (const c of cases) {
    it(`${c.type} 事件 round-trip 且 wire tag 为 ${c.tag}`, () => {
      const encoded = encodeTmuxEventPayload({ deviceId: 'device-1', type: c.type, data: c.data });

      expect(schema.TmuxEventSchema.deserialize(encoded).eventType).toBe(c.tag);

      const decoded = decodeTmuxEventPayload(encoded);
      expect(decoded.deviceId).toBe('device-1');
      expect(decoded.type).toBe(c.type);
      expect(decoded.data).toEqual(c.decoded);
    });
  }

  it('覆盖了全部 TmuxEventType', () => {
    const covered = new Set(cases.map((c) => c.type));
    const all: Array<EventTmuxPayload['type']> = [
      'window-add',
      'window-close',
      'window-renamed',
      'window-active',
      'pane-add',
      'pane-close',
      'pane-active',
      'layout-change',
      'bell',
      'notification',
      'output',
    ];
    expect(all.filter((t) => !covered.has(t))).toEqual([]);
    expect(new Set(cases.map((c) => c.tag)).size).toBe(cases.length);
  });

  it('eventData 损坏时解码回退为空对象', () => {
    const encoded = schema.TmuxEventSchema.serialize({
      deviceId: 'device-1',
      eventType: 3,
      eventData: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    });

    const decoded = decodeTmuxEventPayload(encoded);
    expect(decoded.type).toBe('window-renamed');
    expect(decoded.data).toEqual({});
  });

  it('eventData 为空时解码回退为空对象', () => {
    const encoded = schema.TmuxEventSchema.serialize({
      deviceId: 'device-1',
      eventType: 1,
      eventData: new Uint8Array(),
    });

    expect(decodeTmuxEventPayload(encoded).data).toEqual({});
  });
});

describe('device event codec 表', () => {
  const cases: Array<{ type: EventDevicePayload['type']; tag: number }> = [
    { type: 'tmux-missing', tag: 1 },
    { type: 'disconnected', tag: 2 },
    { type: 'error', tag: 3 },
    { type: 'reconnected', tag: 4 },
  ];

  for (const c of cases) {
    it(`${c.type} round-trip 且 wire tag 为 ${c.tag}`, () => {
      const encoded = encodeDeviceEventPayload({ deviceId: 'device-1', type: c.type });
      expect(schema.DeviceEventSchema.deserialize(encoded).eventType).toBe(c.tag);
      expect(decodeDeviceEventPayload(encoded).type).toBe(c.type);
    });
  }

  it('未知 device event tag 回退为 error', () => {
    const encoded = schema.DeviceEventSchema.serialize({
      deviceId: 'device-1',
      eventType: 200,
      errorType: null,
      message: null,
      rawMessage: null,
    });

    expect(decodeDeviceEventPayload(encoded).type).toBe('error');
  });
});
