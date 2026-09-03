import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
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
  test('pins all five server command variants to their schema bytes', () => {
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

  test('keeps selection control on legacy but suppresses its legacy history capture', () => {
    const encoded = encodeGatewayTransportCommand(
      {
        type: 'select-pane',
        deviceId: 'device-a',
        windowId: '@1',
        paneId: '%1',
        selectToken: ZERO,
        wantHistory: true,
      },
      { stateFeedMode: 'canonical' }
    );
    expect(encoded.kind).toBe(wsBorsh.KIND_TMUX_SELECT);
    expect(
      wsBorsh.decodePayload(wsBorsh.schema.TmuxSelectSchema, encoded.payload).wantHistory
    ).toBe(false);
  });
});
