import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { decodeGatewayTransportMessage, decodeNodeEventMessage } from './transport-message-decoder';
import type { GatewayTransportEvent } from './transport-types';

function collect(
  kind: number,
  payload: Uint8Array
): {
  handled: boolean;
  events: GatewayTransportEvent[];
} {
  const events: GatewayTransportEvent[] = [];
  const handled = decodeGatewayTransportMessage(kind, payload, (event) => events.push(event));
  return { handled, events };
}

describe('decodeGatewayTransportMessage', () => {
  // 这些 kind 号在 1.1.23 随 legacy 状态流一起删掉，常量已不存在，只能按裸数字断言。
  test('legacy 状态流 kind 已下线：不再登记解码器', () => {
    for (const kind of [
      0x0208, 0x0209, 0x020d, 0x020e, 0x0303, 0x0304, 0x0305, 0x0306, 0x0401, 0x0402,
    ]) {
      const { handled, events } = collect(kind, new Uint8Array(0));
      expect(handled).toBe(false);
      expect(events).toEqual([]);
    }
  });

  test('device-connected / device-disconnected', () => {
    const connected = collect(
      wsBorsh.KIND_DEVICE_CONNECTED,
      wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, { deviceId: 'dev-1' })
    );
    expect(connected.handled).toBe(true);
    expect(connected.events).toEqual([{ type: 'device-connected', deviceId: 'dev-1' }]);

    const disconnected = collect(
      wsBorsh.KIND_DEVICE_DISCONNECTED,
      wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectedSchema, { deviceId: 'dev-1' })
    );
    expect(disconnected.events).toEqual([{ type: 'device-disconnected', deviceId: 'dev-1' }]);
  });

  test('terminal-viewport-policy', () => {
    const { handled, events } = collect(
      wsBorsh.KIND_TERM_VIEWPORT_POLICY,
      wsBorsh.encodePayload(wsBorsh.schema.TermViewportPolicySchema, {
        deviceId: 'dev-1',
        windowId: '@1',
        paneId: '%2',
        owner: false,
        cols: 160,
        rows: 48,
      })
    );
    expect(handled).toBe(true);
    expect(events).toEqual([
      {
        type: 'terminal-viewport-policy',
        kind: 'terminal-viewport-policy',
        deviceId: 'dev-1',
        windowId: '@1',
        paneId: '%2',
        owner: false,
        cols: 160,
        rows: 48,
      },
    ]);
  });

  test('clipboard-write', () => {
    const { events } = collect(
      wsBorsh.KIND_CLIPBOARD_WRITE,
      wsBorsh.encodePayload(wsBorsh.schema.ClipboardWriteSchema, {
        deviceId: 'dev-1',
        paneId: '%1',
        text: 'copied',
      })
    );
    expect(events).toEqual([
      { type: 'clipboard-write', deviceId: 'dev-1', paneId: '%1', text: 'copied' },
    ]);
  });

  test('site-theme-update 映射到 light / dark', () => {
    const light = collect(
      wsBorsh.KIND_SITE_THEME_UPDATE,
      wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, {
        theme: wsBorsh.SITE_THEME_LIGHT,
        serverTimestamp: 1n,
      })
    );
    expect(light.events).toEqual([{ type: 'site-theme-update', theme: 'light' }]);

    const dark = collect(
      wsBorsh.KIND_SITE_THEME_UPDATE,
      wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, {
        theme: wsBorsh.SITE_THEME_DARK,
        serverTimestamp: 1n,
      })
    );
    expect(dark.events).toEqual([{ type: 'site-theme-update', theme: 'dark' }]);
  });

  test('settings-update 透出 namespace 原样', () => {
    for (const namespace of ['site', 'llm', 'tree-order']) {
      const { handled, events } = collect(
        wsBorsh.KIND_SETTINGS_UPDATE,
        wsBorsh.encodePayload(wsBorsh.schema.SettingsUpdateS2CSchema, {
          namespace,
          serverTimestamp: 1_700_000_000_000n,
        })
      );
      expect(handled).toBe(true);
      expect(events).toEqual([{ type: 'settings-update', namespace }]);
    }
  });

  test('KIND_ERROR 转成 transport-error', () => {
    const { events } = collect(
      wsBorsh.KIND_ERROR,
      wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
        refSeq: null,
        code: 42,
        message: 'boom',
        retryable: false,
      })
    );

    expect(events.length).toBe(1);
    const event = events[0] as Extract<GatewayTransportEvent, { type: 'transport-error' }>;
    expect(event.type).toBe('transport-error');
    expect(event.error.message).toBe('boom');
  });

  function collectTooOld(message: string) {
    return collect(
      wsBorsh.KIND_ERROR,
      wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
        refSeq: null,
        code: wsBorsh.ERROR_UNSUPPORTED_PROTOCOL,
        message,
        retryable: false,
      })
    );
  }

  test('canonical v1.1 门槛拒绝的 ERROR 转成 server-too-old，并带上被拒节点与版本', () => {
    const { handled, events } = collectTooOld(
      wsBorsh.formatCanonicalV11RequiredError({
        side: 'node',
        nodeId: 'a1b2c3d4e5f6',
        version: '1.1.22',
      })
    );

    expect(handled).toBe(true);
    expect(events).toEqual([
      {
        type: 'server-too-old',
        side: 'node',
        minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
        version: '1.1.22',
        nodeId: 'a1b2c3d4e5f6',
      },
    ]);
  });

  test('本页面被拒时 side 为 client 且没有节点编号', () => {
    const { events } = collectTooOld(
      wsBorsh.formatCanonicalV11RequiredError({ side: 'client', version: '1.1.22' })
    );
    expect(events).toEqual([
      {
        type: 'server-too-old',
        side: 'client',
        minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
        version: '1.1.22',
        nodeId: null,
      },
    ]);
  });

  test('节点编号与版本都未知时归一成 null', () => {
    const { events } = collectTooOld(
      wsBorsh.formatCanonicalV11RequiredError({ side: 'node', nodeId: null, version: null })
    );
    expect(events).toEqual([
      {
        type: 'server-too-old',
        side: 'node',
        minVersion: wsBorsh.CANONICAL_V11_MIN_PEER_VERSION,
        version: null,
        nodeId: null,
      },
    ]);
  });

  test('同码不同 message 的 ERROR 仍是 transport-error', () => {
    const { events } = collect(
      wsBorsh.KIND_ERROR,
      wsBorsh.encodePayload(wsBorsh.schema.ErrorSchema, {
        refSeq: null,
        code: wsBorsh.ERROR_UNSUPPORTED_PROTOCOL,
        message: 'Unsupported protocol version',
        retryable: false,
      })
    );
    expect(events.map((event) => event.type)).toEqual(['transport-error']);
  });

  test('未登记的 kind 被忽略且不产生事件', () => {
    const { handled, events } = collect(0xfffe, new Uint8Array([1, 2, 3]));
    expect(handled).toBe(false);
    expect(events).toEqual([]);
  });

  test('payload 损坏时向上抛出，由订阅侧处理', () => {
    expect(() =>
      decodeGatewayTransportMessage(wsBorsh.KIND_DEVICE_CONNECTED, new Uint8Array([0xff]), () => {})
    ).toThrow();
  });

  test('KIND_NODE_EVENT 带上 version / directCapable / name', () => {
    const payload = wsBorsh.encodePayload(wsBorsh.schema.NodeEventSchema, {
      nodeId: 'aa'.repeat(16),
      status: wsBorsh.NODE_EVENT_STATUS_ONLINE,
      reach: 'relay',
      inventory: '{"devices":[]}',
      version: '9.9.9',
      directCapable: true,
      name: 'studio',
      transport: null,
      rttMs: null,
    });
    expect(decodeNodeEventMessage(payload)).toEqual({
      type: 'node-event',
      nodeId: 'aa'.repeat(16),
      status: 'online',
      reach: 'relay',
      inventory: '{"devices":[]}',
      version: '9.9.9',
      directCapable: true,
      name: 'studio',
    });
  });

  test('KIND_CANONICAL_EVENT SourceGap resource_exhausted yields rebase-required', () => {
    const payload = wsBorsh.encodeCanonicalEventPayload({
      SourceGap: {
        reason: wsBorsh.SOURCE_GAP_REASON_RESOURCE_EXHAUSTED,
        scope: { Stream: {} },
      },
    });
    const { handled, events } = collect(wsBorsh.KIND_CANONICAL_EVENT, payload);
    expect(handled).toBe(true);
    expect(events).toEqual([{ type: 'rebase-required', reason: 'resource_exhausted' }]);
  });
  test('KIND_CANONICAL_EVENT never drops an unknown pane gap reason', () => {
    const epoch = new Uint8Array(16);
    const payload = wsBorsh.encodeCanonicalEventPayload({
      SourceGap: {
        reason: 255,
        scope: {
          Pane: {
            pane: { deviceId: 'dev', serverEpoch: epoch, paneId: '%1' },
            expectedPaneEpoch: epoch,
            availablePaneEpoch: epoch,
            expectedSeq: 1n,
            availableSeq: 2n,
          },
        },
      },
    });
    const { events } = collect(wsBorsh.KIND_CANONICAL_EVENT, payload);
    expect(events).toEqual([
      { type: 'rebase-required', deviceId: 'dev', paneId: '%1', reason: 'pane_gap' },
    ]);
  });
});
