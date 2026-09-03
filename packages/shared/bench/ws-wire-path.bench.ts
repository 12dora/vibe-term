// 用法：bun packages/shared/bench/ws-wire-path.bench.ts
// 对比终端输出热路径的 schema 编解码与融合写入、零拷贝读取路径。

import {
  CANONICAL_STATE_MAX_FRAME_BYTES,
  type CanonicalEvent,
  CanonicalEventEnvelopeSchema,
  encodeCanonicalEventPayload,
  peekCanonicalPaneDataHeader,
} from '../src/ws-borsh/canonical-state';
import {
  DEFAULT_MAX_FRAME_BYTES,
  decodeEnvelope,
  decodeEnvelopeView,
  encodeCanonicalEventFrame,
  encodeEnvelope,
} from '../src/ws-borsh/codec';
import { KIND_CANONICAL_EVENT } from '../src/ws-borsh/kind';

const ZERO_16 = new Uint8Array(16);
const PANE = { deviceId: 'device-0001', serverEpoch: ZERO_16, paneId: '%17' };
let sink = 0;

type Measurement = { label: string; microseconds: number };

function measure(label: string, iterations: number, run: () => number): Measurement {
  for (let index = 0; index < Math.min(iterations, 500); index += 1) sink ^= run();
  const samples: number[] = [];
  for (let round = 0; round < 7; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) sink ^= run();
    samples.push(((performance.now() - started) * 1000) / iterations);
  }
  samples.sort((left, right) => left - right);
  const microseconds = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(`${label.padEnd(48)} ${microseconds.toFixed(3).padStart(10)} µs/op`);
  return { label, microseconds };
}

function compare(
  label: string,
  iterations: number,
  beforeRun: () => number,
  afterRun: () => number,
  beforeLabel = '  schema/reference',
  afterLabel = '  fused encoder'
): number {
  console.log(`\n${label}`);
  const before = measure(beforeLabel, iterations, beforeRun);
  const after = measure(afterLabel, iterations, afterRun);
  const speedup = before.microseconds / after.microseconds;
  console.log(`  speedup ${speedup.toFixed(1)}x`);
  return speedup;
}

function paneDataEvent(data: Uint8Array): Extract<CanonicalEvent, { PaneData: unknown }> {
  return {
    PaneData: {
      pane: PANE,
      paneEpoch: ZERO_16,
      seqStart: 0n,
      seqEnd: BigInt(data.byteLength),
      data,
    },
  };
}

function assertBytesEqual(left: Uint8Array, right: Uint8Array, label: string): void {
  if (left.byteLength !== right.byteLength || left.some((byte, index) => byte !== right[index])) {
    throw new Error(`${label} differs from schema reference`);
  }
}

const emptyCanonicalFrame = encodeCanonicalEventFrame(paneDataEvent(new Uint8Array()), 7);
const canonicalData = new Uint8Array(
  CANONICAL_STATE_MAX_FRAME_BYTES - emptyCanonicalFrame.byteLength
).fill(0x79);
const canonicalEvent = paneDataEvent(canonicalData);
const canonicalReference = () =>
  encodeEnvelope(KIND_CANONICAL_EVENT, encodeCanonicalEventPayload(canonicalEvent), 7);
const canonicalFused = () => encodeCanonicalEventFrame(canonicalEvent, 7);
assertBytesEqual(canonicalReference(), canonicalFused(), 'canonical fused encoder');
compare(
  'canonical PaneData frame encode — 32 KiB frame',
  800,
  () => canonicalReference().byteLength,
  () => canonicalFused().byteLength
);

const canonicalPayload = decodeEnvelopeView(canonicalFused()).payload;
console.log('\ncanonical PaneData decode — 32 KiB frame');
const schemaDecode = measure('  schema deserialize', 1_200, () => {
  const decoded = CanonicalEventEnvelopeSchema.deserialize(canonicalPayload).event;
  return 'PaneData' in decoded ? (decoded.PaneData.data.at(-1) ?? 0) : 0;
});
measure('  zero-copy peek', 1_200, () => {
  const decoded = peekCanonicalPaneDataHeader(canonicalPayload);
  return decoded?.data.at(-1) ?? 0;
});
const ownedDecode = measure('  peek + ownership copy', 1_200, () => {
  const decoded = peekCanonicalPaneDataHeader(canonicalPayload);
  if (!decoded) return 0;
  const owned = decoded.data.slice();
  return owned.at(-1) ?? 0;
});
const decodeSpeedup = schemaDecode.microseconds / ownedDecode.microseconds;
console.log(`  delivered speedup ${decodeSpeedup.toFixed(1)}x`);
if (decodeSpeedup < 20) {
  throw new Error(
    `canonical PaneData fast decode must be at least 20x faster, got ${decodeSpeedup}`
  );
}

const emptyInboundFrame = encodeEnvelope(KIND_CANONICAL_EVENT, new Uint8Array(), 9);
const maxInboundPayload = new Uint8Array(
  DEFAULT_MAX_FRAME_BYTES - emptyInboundFrame.byteLength
).fill(0x7a);
const maxInboundFrame = encodeEnvelope(KIND_CANONICAL_EVENT, maxInboundPayload, 9);
compare(
  'inbound envelope decode + owned payload — 1 MiB frame',
  30,
  () => decodeEnvelope(maxInboundFrame).payload.at(-1) ?? 0,
  () => decodeEnvelopeView(maxInboundFrame).payload.slice().at(-1) ?? 0,
  '  schema + per-byte copy',
  '  view + bulk ownership copy'
);

console.log(`\nsink=${sink}`);
