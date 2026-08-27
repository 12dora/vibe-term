// 用法: bun run packages/shared/bench/canonical-validation.bench.ts
// 对比 canonical payload 校验的两种实现：重新序列化逐字节比对 vs 单遍 reader 扫描。

import { assertCanonicalEncoding } from '../src/ws-borsh/canonical-scan';
import {
  CanonicalCommandEnvelopeSchema,
  type CanonicalEvent,
  CanonicalEventEnvelopeSchema,
  encodeCanonicalCommandPayload,
  encodeCanonicalEventPayload,
} from '../src/ws-borsh/canonical-state';

const ZERO_16 = new Uint8Array(16);
const PANE = { deviceId: 'device-0001', serverEpoch: ZERO_16, paneId: '%17' };

interface SchemaLike {
  readonly type: string;
  readonly options: unknown;
  serialize(value: unknown): Uint8Array;
  deserialize(payload: Uint8Array): unknown;
}

function paneData(bytes: number): CanonicalEvent {
  return {
    PaneData: {
      pane: PANE,
      paneEpoch: ZERO_16,
      seqStart: 0n,
      seqEnd: BigInt(bytes),
      data: new Uint8Array(bytes).fill(0x41),
    },
  };
}

function subscriptions(count: number): Uint8Array {
  return encodeCanonicalCommandPayload({
    SetPaneSubscriptions: {
      generation: 1n,
      activePanes: Array.from({ length: count }, (_unused, index) => ({
        pane: { ...PANE, paneId: `%${index}` },
        cursor: { paneEpoch: ZERO_16, terminalSeq: BigInt(index) },
      })),
      hotPanes: [],
    },
  });
}

function reencodeCheck(schema: SchemaLike, decoded: unknown, payload: Uint8Array): void {
  const canonical = schema.serialize(decoded);
  if (
    canonical.byteLength !== payload.byteLength ||
    canonical.some((byte, index) => byte !== payload[index])
  ) {
    throw new Error('non-canonical payload encoding');
  }
}

function measure(label: string, iterations: number, run: () => void): number {
  for (let index = 0; index < Math.min(iterations, 1_000); index += 1) run();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = performance.now() - start;
  const perOp = (elapsed * 1000) / iterations;
  console.log(`${label.padEnd(46)} ${perOp.toFixed(3)} µs/op  (${elapsed.toFixed(1)} ms)`);
  return perOp;
}

function compare(label: string, schema: SchemaLike, payload: Uint8Array, iterations: number): void {
  console.log(`\n${label} — payload ${payload.byteLength} B, ${iterations} iterations`);
  const decoded = schema.deserialize(payload);
  measure('  deserialize (unchanged, both paths)', iterations, () => {
    schema.deserialize(payload);
  });
  const before = measure('  re-encode + byte compare (before)', iterations, () =>
    reencodeCheck(schema, decoded, payload)
  );
  const after = measure('  reader scan (after)', iterations, () =>
    assertCanonicalEncoding(schema, payload)
  );
  console.log(`  speedup ${(before / after).toFixed(1)}x`);
}

const eventSchema = CanonicalEventEnvelopeSchema as unknown as SchemaLike;
const commandSchema = CanonicalCommandEnvelopeSchema as unknown as SchemaLike;

compare('PaneData 64 B', eventSchema, encodeCanonicalEventPayload(paneData(64)), 20_000);
compare('PaneData 4 KiB', eventSchema, encodeCanonicalEventPayload(paneData(4096)), 5_000);
compare('PaneData 31 KiB', eventSchema, encodeCanonicalEventPayload(paneData(31_744)), 1_000);
compare('SetPaneSubscriptions x16', commandSchema, subscriptions(16), 20_000);
compare(
  'Error event',
  eventSchema,
  encodeCanonicalEventPayload({
    Error: { requestId: ZERO_16, code: 12, message: 'pane not found', retryable: false },
  }),
  20_000
);
