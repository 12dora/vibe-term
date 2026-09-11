// RequestScreenIntent（canonical-screen-intent-v1）的线格约束：
// 变体只能追加在命令枚举尾部（discriminator 6），既有 0..5 的编号与字节一位都不许动，
// 否则 2.1.0 对端会把新命令解成旧命令。

import { describe, expect, test } from 'bun:test';

import {
  type CanonicalCommand,
  decodeCanonicalCommandPayload,
  encodeCanonicalCommandPayload,
} from './canonical-state';
import { WsBorshError } from './errors';

const ZERO_16 = new Uint8Array(16);
const REQUEST_ID = new Uint8Array(16).fill(9);
const PANE = { deviceId: 'device-a', serverEpoch: ZERO_16, paneId: '%3' };

function intent(overrides: Partial<{ windowId: string | null; paneId: string | null }> = {}) {
  return {
    RequestScreenIntent: {
      requestId: REQUEST_ID,
      deviceId: 'device-a',
      windowId: null as string | null,
      paneId: '%3' as string | null,
      byteLimit: 4096,
      ...overrides,
    },
  } satisfies CanonicalCommand;
}

/** payload = protocolVersion(u16) + enum discriminator(u8) + 变体内容 */
function discriminator(command: CanonicalCommand): number[] {
  const payload = encodeCanonicalCommandPayload(command);
  return [payload[0] as number, payload[1] as number, payload[2] as number];
}

describe('canonical RequestScreenIntent 线格', () => {
  test('新变体追加在命令枚举尾部，discriminator 为 6', () => {
    expect(discriminator(intent())).toEqual([1, 0, 6]);
  });

  test('既有变体的 discriminator 全部未变（0..5）', () => {
    expect(
      discriminator({ SetPaneSubscriptions: { generation: 1n, activePanes: [], hotPanes: [] } })
    ).toEqual([1, 0, 0]);
    expect(
      discriminator({
        TerminalInput: {
          requestId: REQUEST_ID,
          pane: PANE,
          paneEpoch: ZERO_16,
          inputId: REQUEST_ID,
          data: new Uint8Array([1]),
        },
      })
    ).toEqual([1, 0, 1]);
    expect(
      discriminator({ ResizePane: { requestId: REQUEST_ID, pane: PANE, rows: 40, cols: 120 } })
    ).toEqual([1, 0, 2]);
    expect(
      discriminator({ RequestScreen: { requestId: REQUEST_ID, pane: PANE, byteLimit: 64 } })
    ).toEqual([1, 0, 3]);
    expect(
      discriminator({
        RequestHistory: { requestId: REQUEST_ID, pane: PANE, beforeCursor: null, byteLimit: 64 },
      })
    ).toEqual([1, 0, 4]);
    expect(
      discriminator({
        ResizePaneV11: {
          requestId: REQUEST_ID,
          pane: PANE,
          rows: 40,
          cols: 120,
          geometryReason: 0,
          sizeEpoch: 1n,
        },
      })
    ).toEqual([1, 0, 5]);
  });

  test('字段顺序为 requestId / deviceId / windowId / paneId / byteLimit', () => {
    const payload = encodeCanonicalCommandPayload(intent({ windowId: '@1', paneId: '%3' }));
    const golden = [
      1,
      0, // protocolVersion u16 = 1
      6, // discriminator
      ...REQUEST_ID,
      8,
      0,
      0,
      0,
      ...new TextEncoder().encode('device-a'),
      1,
      2,
      0,
      0,
      0,
      ...new TextEncoder().encode('@1'), // Some('@1')
      1,
      2,
      0,
      0,
      0,
      ...new TextEncoder().encode('%3'), // Some('%3')
      0,
      16,
      0,
      0, // byteLimit u32 = 4096
    ];
    expect([...payload]).toEqual(golden);
  });

  test('windowId / paneId 四种组合都能原样 round trip（None 编码为单字节 0）', () => {
    for (const windowId of [null, '@7']) {
      for (const paneId of [null, '%7']) {
        const command = intent({ windowId, paneId });
        expect(
          decodeCanonicalCommandPayload(encodeCanonicalCommandPayload(command)).command
        ).toEqual(command);
      }
    }
    const payload = encodeCanonicalCommandPayload(intent({ windowId: null, paneId: null }));
    expect(payload.at(-5)).toBe(0);
    expect(payload.at(-6)).toBe(0);
  });

  test('未知变体（讲不出这条能力的对端收到更新的命令）解码即报错，不会错认成旧命令', () => {
    const payload = encodeCanonicalCommandPayload(intent());
    const unknown = payload.slice();
    unknown[2] = 7;
    expect(() => decodeCanonicalCommandPayload(unknown)).toThrow(WsBorshError);
  });
});
