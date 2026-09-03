// 用法: bun apps/gateway/bench/envelope-view.bench.ts
// 对比 mesh 中继热路径上 decodeEnvelope（逐字节 copy）vs decodeEnvelopeView（常数时间 header）。

import { wsBorsh } from '@tmex/shared';

const PAYLOAD = 32 * 1024;
const ITERATIONS = 2_000;

// 本 bench 只量 envelope 头部解析，payload 用等长的原始字节即可（内容不参与）。
function encodeFrame(bytes: number): Uint8Array {
  return wsBorsh.encodeEnvelope(wsBorsh.KIND_CANONICAL_EVENT, new Uint8Array(bytes).fill(0x41), 1);
}

function measure(label: string, iterations: number, run: () => void): number {
  for (let i = 0; i < Math.min(iterations, 200); i += 1) run();
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) run();
  const elapsed = performance.now() - start;
  const perOpUs = (elapsed * 1000) / iterations;
  console.log(`${label.padEnd(42)} ${perOpUs.toFixed(3)} µs/op  (${elapsed.toFixed(1)} ms)`);
  return perOpUs;
}

const frame = encodeFrame(PAYLOAD);
console.log(`PaneData frame ${frame.byteLength} B, payload ${PAYLOAD} B, ${ITERATIONS} iterations`);
const copy = measure('decodeEnvelope (copy)', ITERATIONS, () => {
  wsBorsh.decodeEnvelope(frame);
});
const view = measure('decodeEnvelopeView (view)', ITERATIONS, () => {
  wsBorsh.decodeEnvelopeView(frame);
});
console.log(`speedup ${(copy / view).toFixed(1)}x`);
