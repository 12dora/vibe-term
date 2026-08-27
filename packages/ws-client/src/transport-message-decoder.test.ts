import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { decodeGatewayTransportMessage } from './transport-message-decoder';
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

const token = new Uint8Array(16).fill(3);

describe('decodeGatewayTransportMessage', () => {
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

  test('terminal-data 保留原始字节', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const { events } = collect(
      wsBorsh.KIND_TERM_OUTPUT,
      wsBorsh.encodePayload(wsBorsh.schema.TermOutputSchema, {
        deviceId: 'dev-1',
        paneId: '%1',
        encoding: 0,
        data,
      })
    );

    expect(events).toEqual([
      { type: 'terminal-data', frame: { deviceId: 'dev-1', paneId: '%1', data } },
    ]);
  });

  test('legacy-history 把字节解码成文本', () => {
    const { events } = collect(
      wsBorsh.KIND_TERM_HISTORY,
      wsBorsh.encodePayload(wsBorsh.schema.TermHistorySchema, {
        deviceId: 'dev-1',
        paneId: '%2',
        selectToken: token,
        encoding: 0,
        alternateScreen: true,
        modes: 5,
        data: new TextEncoder().encode('hello 历史'),
      })
    );

    expect(events).toEqual([
      {
        type: 'legacy-history',
        deviceId: 'dev-1',
        paneId: '%2',
        selectToken: token,
        data: 'hello 历史',
        alternateScreen: true,
        modes: 5,
      },
    ]);
  });

  test('selection-ack / live-resume 携带 selectToken', () => {
    const ack = collect(
      wsBorsh.KIND_SWITCH_ACK,
      wsBorsh.encodePayload(wsBorsh.schema.SwitchAckSchema, {
        deviceId: 'dev-1',
        windowId: '@1',
        paneId: '%1',
        selectToken: token,
      })
    );
    expect(ack.events).toEqual([{ type: 'selection-ack', deviceId: 'dev-1', selectToken: token }]);

    const resume = collect(
      wsBorsh.KIND_LIVE_RESUME,
      wsBorsh.encodePayload(wsBorsh.schema.LiveResumeSchema, {
        deviceId: 'dev-1',
        paneId: '%1',
        selectToken: token,
      })
    );
    expect(resume.events).toEqual([{ type: 'live-resume', deviceId: 'dev-1', selectToken: token }]);
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

  test('metadata-patch 仅接受 absolute-json 格式', () => {
    const diff = { upserts: [], removals: [{ entityKind: 3, nativeId: '%1' }] };
    const diffBytes = wsBorsh.encodeLegacyStateSnapshotDiff(diff);

    const accepted = collect(
      wsBorsh.KIND_STATE_SNAPSHOT_DIFF,
      wsBorsh.encodePayload(wsBorsh.schema.StateSnapshotDiffSchema, {
        deviceId: 'dev-1',
        baseRevision: 1,
        revision: 2,
        diffFormat: wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON,
        diffBytes,
      })
    );
    expect(accepted.events).toEqual([{ type: 'metadata-patch', deviceId: 'dev-1', patch: diff }]);

    const ignored = collect(
      wsBorsh.KIND_STATE_SNAPSHOT_DIFF,
      wsBorsh.encodePayload(wsBorsh.schema.StateSnapshotDiffSchema, {
        deviceId: 'dev-1',
        baseRevision: 1,
        revision: 2,
        diffFormat: wsBorsh.STATE_SNAPSHOT_DIFF_FORMAT_ABSOLUTE_JSON + 1,
        diffBytes,
      })
    );
    expect(ignored.handled).toBe(true);
    expect(ignored.events).toEqual([]);
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
});
