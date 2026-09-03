import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  CANONICAL_ONLY_COMMANDS,
  encodeCanonicalGatewayCommand,
  encodeGatewayTransportCommand,
} from './transport-command-encoder';

const ZERO = new Uint8Array(16);
const EPOCH = Uint8Array.from({ length: 16 }, (_, index) => index);
const PANE = { deviceId: 'dev-1', serverEpoch: EPOCH, paneId: '%7' };

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('canonical gateway command encoder', () => {
  test('pins every server command variant to its schema bytes', () => {
    const commands: Array<[wsBorsh.CanonicalCommand, string]> = [
      [
        {
          SetPaneSubscriptions: {
            generation: 7n,
            activePanes: [{ pane: PANE, cursor: null }],
            hotPanes: [],
          },
        },
        '010000070000000000000001000000050000006465762d31000102030405060708090a0b0c0d0e0f0200000025370000000000',
      ],
      [
        {
          TerminalInput: {
            requestId: ZERO,
            pane: PANE,
            paneEpoch: ZERO,
            inputId: EPOCH,
            data: new Uint8Array([65, 66]),
          },
        },
        '01000100000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f02000000253700000000000000000000000000000000000102030405060708090a0b0c0d0e0f020000004142',
      ],
      [
        { ResizePane: { requestId: ZERO, pane: PANE, rows: 24, cols: 80 } },
        '01000200000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f02000000253718005000',
      ],
      [
        { RequestScreen: { requestId: ZERO, pane: PANE, byteLimit: 4096 } },
        '01000300000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f02000000253700100000',
      ],
      [
        {
          RequestHistory: {
            requestId: ZERO,
            pane: PANE,
            beforeCursor: { paneEpoch: ZERO, historyEpoch: EPOCH, beforeLine: 99 },
            byteLimit: 4096,
          },
        },
        '01000400000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f0200000025370100000000000000000000000000000000000102030405060708090a0b0c0d0e0f6300000000100000',
      ],
      [
        {
          ResizePaneV11: {
            requestId: ZERO,
            pane: PANE,
            rows: 24,
            cols: 80,
            geometryReason: wsBorsh.CANONICAL_GEOMETRY_REASON_RESEND,
            sizeEpoch: 7n,
          },
        },
        '01000500000000000000000000000000000000050000006465762d31000102030405060708090a0b0c0d0e0f02000000253718005000010700000000000000',
      ],
    ];

    for (const [command, expected] of commands) {
      const encoded = encodeCanonicalGatewayCommand(command, 32 * 1024);
      expect(encoded.kind).toBe(wsBorsh.KIND_CANONICAL_COMMAND);
      expect(hex(encoded.payload)).toBe(expected);
      expect(wsBorsh.decodeCanonicalCommandPayload(encoded.payload).command).toEqual(command);
    }
  });

  test('rejects a complete canonical envelope above the negotiated frame limit', () => {
    expect(() =>
      encodeCanonicalGatewayCommand(
        {
          TerminalInput: {
            requestId: ZERO,
            pane: PANE,
            paneEpoch: ZERO,
            inputId: ZERO,
            data: new Uint8Array(128),
          },
        },
        128
      )
    ).toThrow(wsBorsh.WsBorshError);
  });

  test('select-pane 仍走 TMUX_SELECT 控制帧，wantHistory 恒为 false', () => {
    const encoded = encodeGatewayTransportCommand({
      type: 'select-pane',
      deviceId: 'device-a',
      windowId: '@1',
      paneId: '%1',
      selectToken: ZERO,
    });
    expect(encoded.kind).toBe(wsBorsh.KIND_TMUX_SELECT);
    expect(
      wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, encoded.payload).wantHistory
    ).toBe(false);
  });

  test('canonical 覆盖的命令没有控制帧编码', () => {
    for (const command of CANONICAL_ONLY_COMMANDS) {
      expect(() => encodeGatewayTransportCommand({ type: command } as never)).toThrow(
        /no control frame/
      );
    }
  });
});
