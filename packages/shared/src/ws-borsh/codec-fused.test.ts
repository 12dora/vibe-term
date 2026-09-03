import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_STATE_MAX_FRAME_BYTES,
  type CanonicalEvent,
  encodeCanonicalEventPayload,
} from './canonical-state';
import { encodeCanonicalEventFrame, encodeEnvelope } from './codec';
import { ERROR_FRAME_TOO_LARGE, WsBorshError } from './errors';
import { KIND_CANONICAL_EVENT } from './kind';

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const SERVER_EPOCH = Uint8Array.from({ length: 16 }, (_unused, index) => index);
const PANE_EPOCH = Uint8Array.from({ length: 16 }, (_unused, index) => 0xff - index);

function paneDataEvent(
  data: Uint8Array,
  options: {
    deviceId?: string;
    paneId?: string;
    seqStart?: bigint;
    serverEpoch?: Uint8Array;
    paneEpoch?: Uint8Array;
  } = {}
): Extract<CanonicalEvent, { PaneData: unknown }> {
  const seqStart = options.seqStart ?? 0n;
  return {
    PaneData: {
      pane: {
        deviceId: options.deviceId ?? 'device-a',
        serverEpoch: options.serverEpoch ?? SERVER_EPOCH,
        paneId: options.paneId ?? '%1',
      },
      paneEpoch: options.paneEpoch ?? PANE_EPOCH,
      seqStart,
      seqEnd: seqStart + BigInt(data.byteLength),
      data,
    },
  };
}

function referenceCanonicalEvent(event: CanonicalEvent, seq: number): Uint8Array {
  return encodeEnvelope(KIND_CANONICAL_EVENT, encodeCanonicalEventPayload(event), seq);
}

let randomState = 0x6d2b_79f5;

function randomU32(): number {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return randomState >>> 0;
}

function randomBytes(length: number): Uint8Array {
  const backing = new Uint8Array(length + 7);
  for (let index = 0; index < backing.byteLength; index += 1) {
    backing[index] = randomU32() & 0xff;
  }
  return backing.subarray(3, 3 + length);
}

function randomString(maxLength: number): string {
  const characters = ['a', 'Z', '0', '-', '\0', 'é', '中', '🙂'];
  const length = randomU32() % (maxLength + 1);
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += characters[randomU32() % characters.length];
  }
  return result;
}

describe('fused canonical PaneData frame encoder', () => {
  const emptyEvent = paneDataEvent(new Uint8Array());
  const emptyFrameBytes = referenceCanonicalEvent(emptyEvent, 0).byteLength;
  const maxDataBytes = CANONICAL_STATE_MAX_FRAME_BYTES - emptyFrameBytes;
  const cases: Array<[string, Extract<CanonicalEvent, { PaneData: unknown }>, number]> = [
    ['empty payload', emptyEvent, 0],
    ['one byte', paneDataEvent(randomBytes(1)), 1],
    ['maximum frame', paneDataEvent(randomBytes(maxDataBytes)), 0xffff_ffff],
    [
      'non-ASCII ids',
      paneDataEvent(randomBytes(513), { deviceId: '设备🙂-é', paneId: '%窗格-β' }),
      0x8000_0000,
    ],
    ['u64 sequence boundary', paneDataEvent(randomBytes(257), { seqStart: U64_MAX - 257n }), 17],
  ];

  for (const [label, event, seq] of cases) {
    test(`is byte-identical for ${label}`, () => {
      expect(encodeCanonicalEventFrame(event, seq)).toEqual(referenceCanonicalEvent(event, seq));
    });
  }

  test('preserves the generic schema path for non-PaneData events', () => {
    const event: CanonicalEvent = {
      Error: { requestId: null, code: 9, message: '窗口不存在', retryable: false },
    };
    expect(encodeCanonicalEventFrame(event, 42)).toEqual(referenceCanonicalEvent(event, 42));
  });

  test('rejects the first byte above the canonical frame limit and a 64 KiB payload', () => {
    for (const dataBytes of [maxDataBytes + 1, 64 * 1024]) {
      const event = paneDataEvent(new Uint8Array(dataBytes));
      for (const encode of [
        () => referenceCanonicalEvent(event, 1),
        () => encodeCanonicalEventFrame(event, 1),
      ]) {
        expect(encode).toThrow(WsBorshError);
        try {
          encode();
        } catch (error) {
          expect((error as WsBorshError).code).toBe(ERROR_FRAME_TOO_LARGE);
        }
      }
    }
  });

  test('is byte-identical for seeded random inputs', () => {
    for (let index = 0; index < 250; index += 1) {
      const data = randomBytes(randomU32() % 2049);
      const rawStart = (BigInt(randomU32()) << 32n) | BigInt(randomU32());
      const seqStart =
        rawStart > U64_MAX - BigInt(data.byteLength)
          ? rawStart - BigInt(data.byteLength)
          : rawStart;
      const event = paneDataEvent(data, {
        deviceId: randomString(24),
        paneId: randomString(12),
        seqStart,
        serverEpoch: randomBytes(16),
        paneEpoch: randomBytes(16),
      });
      const seq = randomU32();
      expect(encodeCanonicalEventFrame(event, seq)).toEqual(referenceCanonicalEvent(event, seq));
    }
  });
});
