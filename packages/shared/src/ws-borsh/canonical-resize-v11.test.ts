import { describe, expect, test } from 'bun:test';

import {
  CANONICAL_GEOMETRY_REASON_CHANGE,
  CANONICAL_GEOMETRY_REASON_RESEND,
  CanonicalGeometryReason,
  isCanonicalGeometryReason,
} from './canonical-geometry';
import {
  type CanonicalCommand,
  CanonicalCommandEnvelopeSchema,
  CanonicalResizePaneV11Schema,
  decodeCanonicalCommandPayload,
  encodeCanonicalCommandPayload,
} from './canonical-state';
import { ERROR_INVALID_FRAME, WsBorshError } from './errors';

const ZERO_16 = new Uint8Array(16);
const REQUEST_ID = new Uint8Array(16).fill(9);
const PANE = { deviceId: 'device-a', serverEpoch: ZERO_16, paneId: '%3' };

function resizeV11(overrides: Partial<CanonicalResizeV11Fields> = {}): CanonicalCommand {
  return {
    ResizePaneV11: {
      requestId: REQUEST_ID,
      pane: PANE,
      rows: 40,
      cols: 120,
      geometryReason: CANONICAL_GEOMETRY_REASON_CHANGE,
      sizeEpoch: 7n,
      ...overrides,
    },
  };
}

type CanonicalResizeV11Fields = Extract<
  CanonicalCommand,
  { ResizePaneV11: unknown }
>['ResizePaneV11'];

describe('canonical v1.1 ResizePaneV11', () => {
  test('新变体追加在命令枚举尾部，discriminator 为 5', () => {
    const payload = encodeCanonicalCommandPayload(resizeV11());
    expect(payload[0]).toBe(1);
    expect(payload[1]).toBe(0);
    expect(payload[2]).toBe(5);
  });

  test('v1 的 ResizePane discriminator 仍为 2，schema 未被改动', () => {
    const payload = encodeCanonicalCommandPayload({
      ResizePane: { requestId: REQUEST_ID, pane: PANE, rows: 40, cols: 120 },
    });
    expect(payload[2]).toBe(2);
  });

  test('change / resend 均可 round trip，sizeEpoch 为 bigint', () => {
    for (const geometryReason of [
      CANONICAL_GEOMETRY_REASON_CHANGE,
      CANONICAL_GEOMETRY_REASON_RESEND,
    ]) {
      const command = resizeV11({ geometryReason, sizeEpoch: 2n ** 40n });
      const decoded = decodeCanonicalCommandPayload(encodeCanonicalCommandPayload(command));
      expect(decoded.command).toEqual(command);
      const fields = (decoded.command as { ResizePaneV11: CanonicalResizeV11Fields }).ResizePaneV11;
      expect(typeof fields.sizeEpoch).toBe('bigint');
      expect(fields.sizeEpoch).toBe(2n ** 40n);
      expect(fields.geometryReason).toBe(geometryReason);
    }
  });

  test('字段顺序为 requestId / pane / rows / cols / geometryReason / sizeEpoch', () => {
    const command = resizeV11({ rows: 0x1122, cols: 0x3344, sizeEpoch: 1n });
    const payload = encodeCanonicalCommandPayload(command);
    let offset = 3;
    expect([...payload.subarray(offset, offset + 16)]).toEqual([...REQUEST_ID]);
    offset += 16;
    const deviceLen = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(
      0,
      true
    );
    offset += 4 + deviceLen + 16;
    const paneLen = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, true);
    offset += 4 + paneLen;
    expect([payload[offset], payload[offset + 1]]).toEqual([0x22, 0x11]);
    expect([payload[offset + 2], payload[offset + 3]]).toEqual([0x44, 0x33]);
    expect(payload[offset + 4]).toBe(CANONICAL_GEOMETRY_REASON_CHANGE);
    expect(
      new DataView(payload.buffer, payload.byteOffset + offset + 5, 8).getBigUint64(0, true)
    ).toBe(1n);
    expect(payload.byteLength).toBe(offset + 13);
  });

  test('编码侧拒绝未知 geometryReason', () => {
    expect(() => encodeCanonicalCommandPayload(resizeV11({ geometryReason: 2 }))).toThrow(
      WsBorshError
    );
    try {
      encodeCanonicalCommandPayload(resizeV11({ geometryReason: 255 }));
    } catch (error) {
      expect((error as WsBorshError).code).toBe(ERROR_INVALID_FRAME);
    }
  });

  test('解码侧同样拒绝未知 geometryReason（对端不可信）', () => {
    const payload = CanonicalCommandEnvelopeSchema.serialize({
      protocolVersion: 1,
      command: {
        ResizePaneV11: {
          requestId: REQUEST_ID,
          pane: PANE,
          rows: 40,
          cols: 120,
          geometryReason: 3,
          sizeEpoch: 1n,
        },
      },
    });
    expect(() => decodeCanonicalCommandPayload(payload)).toThrow(WsBorshError);
  });

  test('sizeEpoch 为 0 属于保留值，编解码两侧都拒绝', () => {
    expect(() => encodeCanonicalCommandPayload(resizeV11({ sizeEpoch: 0n }))).toThrow(WsBorshError);
    const payload = CanonicalCommandEnvelopeSchema.serialize({
      protocolVersion: 1,
      command: {
        ResizePaneV11: {
          requestId: REQUEST_ID,
          pane: PANE,
          rows: 40,
          cols: 120,
          geometryReason: CANONICAL_GEOMETRY_REASON_RESEND,
          sizeEpoch: 0n,
        },
      },
    });
    expect(() => decodeCanonicalCommandPayload(payload)).toThrow(WsBorshError);
  });

  test('v1 命令不受新语义校验影响', () => {
    const command: CanonicalCommand = {
      TerminalInput: {
        requestId: REQUEST_ID,
        pane: PANE,
        paneEpoch: ZERO_16,
        inputId: REQUEST_ID,
        data: new Uint8Array([1, 2, 3]),
      },
    };
    expect(decodeCanonicalCommandPayload(encodeCanonicalCommandPayload(command)).command).toEqual(
      command
    );
  });

  test('CanonicalGeometryReason 常量与守卫一致', () => {
    expect(CanonicalGeometryReason.Change).toBe(0);
    expect(CanonicalGeometryReason.Resend).toBe(1);
    expect(isCanonicalGeometryReason(0)).toBe(true);
    expect(isCanonicalGeometryReason(1)).toBe(true);
    expect(isCanonicalGeometryReason(2)).toBe(false);
    expect(isCanonicalGeometryReason(-1)).toBe(false);
  });

  test('schema 直接序列化的字节与命令封套内的一致', () => {
    const fields: CanonicalResizeV11Fields = {
      requestId: REQUEST_ID,
      pane: PANE,
      rows: 24,
      cols: 80,
      geometryReason: CANONICAL_GEOMETRY_REASON_RESEND,
      sizeEpoch: 12n,
    };
    const standalone = CanonicalResizePaneV11Schema.serialize(fields);
    const envelope = encodeCanonicalCommandPayload({ ResizePaneV11: fields });
    expect([...envelope.subarray(3)]).toEqual([...standalone]);
  });
});
