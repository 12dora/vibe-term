import { describe, expect, test } from 'bun:test';
import {
  CANONICAL_STATE_MAX_FRAME_BYTES,
  type CanonicalEvent,
  encodeCanonicalEventPayload,
} from './canonical-state';
import {
  CURRENT_VERSION,
  DEFAULT_MAX_FRAME_BYTES,
  encodeCanonicalEventFrame,
  encodeEnvelope,
  encodePayload,
  encodeTermOutputFrame,
} from './codec';
import { ERROR_FRAME_TOO_LARGE, WsBorshError } from './errors';
import { KIND_CANONICAL_EVENT, KIND_TERM_OUTPUT } from './kind';
import { TermOutputSchema } from './schema';

const U64_MAX = 0xffff_ffff_ffff_ffffn;
const SERVER_EPOCH = Uint8Array.from({ length: 16 }, (_unused, index) => index);
const PANE_EPOCH = Uint8Array.from({ length: 16 }, (_unused, index) => 0xff - index);

type TermOutput = Parameters<typeof encodeTermOutputFrame>[0];

function referenceTermOutput(
  value: TermOutput,
  seq: number,
  flags = 0,
  version = CURRENT_VERSION
): Uint8Array {
  return encodeEnvelope(
    KIND_TERM_OUTPUT,
    encodePayload(TermOutputSchema, value),
    seq,
    flags,
    version
  );
}

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

describe('fused TERM_OUTPUT frame encoder', () => {
  const baseValue: TermOutput = {
    deviceId: 'device-a',
    paneId: '%1',
    encoding: 1,
    data: new Uint8Array(),
  };
  const emptyFrameBytes = referenceTermOutput(baseValue, 0).byteLength;
  const frameBoundaryData = (frameBytes: number) =>
    new Uint8Array(Math.max(0, frameBytes - emptyFrameBytes));
  const cases: Array<[string, TermOutput]> = [
    ['empty payload', baseValue],
    ['one byte', { ...baseValue, data: randomBytes(1) }],
    ['64 KiB', { ...baseValue, data: randomBytes(64 * 1024) }],
    [
      'non-ASCII ids',
      { deviceId: '设备🙂-é', paneId: '%窗格-β', encoding: 0xff, data: randomBytes(257) },
    ],
    ['32 KiB boundary - 1', { ...baseValue, data: frameBoundaryData(32 * 1024 - 1) }],
    ['32 KiB boundary', { ...baseValue, data: frameBoundaryData(32 * 1024) }],
    ['32 KiB boundary + 1', { ...baseValue, data: frameBoundaryData(32 * 1024 + 1) }],
    [
      'maximum negotiated frame',
      { ...baseValue, data: frameBoundaryData(DEFAULT_MAX_FRAME_BYTES) },
    ],
    ['first chunked byte', { ...baseValue, data: frameBoundaryData(DEFAULT_MAX_FRAME_BYTES + 1) }],
  ];

  for (const [label, value] of cases) {
    test(`is byte-identical for ${label}`, () => {
      expect(encodeTermOutputFrame(value, 0xffff_fffe)).toEqual(
        referenceTermOutput(value, 0xffff_fffe)
      );
    });
  }

  test('is byte-identical across envelope sequence and flag boundaries', () => {
    for (const seq of [0, 1, 0x7fff_ffff, 0xffff_ffff]) {
      for (const [flags, version] of [
        [0, 0],
        [1, CURRENT_VERSION],
        [0xffff, 0xffff],
      ] as const) {
        expect(encodeTermOutputFrame(baseValue, seq, flags, version)).toEqual(
          referenceTermOutput(baseValue, seq, flags, version)
        );
      }
    }
  });

  test('is byte-identical for seeded random inputs', () => {
    for (let index = 0; index < 250; index += 1) {
      const value: TermOutput = {
        deviceId: randomString(24),
        paneId: randomString(12),
        encoding: randomU32() & 0xff,
        data: randomBytes(randomU32() % 4097),
      };
      const seq = randomU32();
      const flags = randomU32() & 0xffff;
      const version = randomU32() & 0xffff;
      expect(encodeTermOutputFrame(value, seq, flags, version)).toEqual(
        referenceTermOutput(value, seq, flags, version)
      );
    }
  });
});

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
