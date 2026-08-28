// writeVt 的每次调用成本：旧实现每次 alloc + copy + free 一块 WASM 缓冲，
// 现实现复用常驻 scratch（字符串走 encodeInto 直接写进线性内存，省掉中间 JS Uint8Array）。
// 运行：bun packages/ghostty-terminal/bench/write-vt.bench.ts
import { type GhosttyBindings, getGhosttyBindings } from '../src/ghostty-wasm';

const COLS = 120;
const ROWS = 40;
const WRITES = 10_000;
const PAYLOAD_BYTES = 64;
const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 10;

const payloadText = 'the quick brown fox jumps over the lazy dog 0123456789abcdefghij'.slice(
  0,
  PAYLOAD_BYTES
);
const payloadBytes = new TextEncoder().encode(payloadText);
const COALESCE_FACTOR = 10;
const coalescedBytes = new TextEncoder().encode(payloadText.repeat(COALESCE_FACTOR));
const encoder = new TextEncoder();

function legacyWriteVt(
  bindings: GhosttyBindings,
  terminal: number,
  data: string | Uint8Array
): void {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const allocation = bindings.writeBytes(bytes);
  try {
    bindings.exports.ghostty_terminal_vt_write(terminal, allocation.ptr, allocation.len);
  } finally {
    allocation.free();
  }
}

function measure(label: string, run: () => void): void {
  for (let round = 0; round < WARMUP_ROUNDS; round += 1) run();

  const samples: number[] = [];
  for (let round = 0; round < MEASURED_ROUNDS; round += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  const perWriteNs = (median * 1e6) / WRITES;
  console.log(
    `${label.padEnd(34)} median ${median.toFixed(2)} ms  (${perWriteNs.toFixed(0)} ns / write)`
  );
}

const bindings = await getGhosttyBindings();
const terminal = bindings.createTerminal(COLS, ROWS, 1000);

try {
  measure('legacy bytes (alloc/copy/free)', () => {
    for (let index = 0; index < WRITES; index += 1) legacyWriteVt(bindings, terminal, payloadBytes);
  });
  measure('scratch bytes', () => {
    for (let index = 0; index < WRITES; index += 1) bindings.writeVt(terminal, payloadBytes);
  });
  measure('legacy string (encode + alloc)', () => {
    for (let index = 0; index < WRITES; index += 1) legacyWriteVt(bindings, terminal, payloadText);
  });
  measure('scratch string (encodeInto)', () => {
    for (let index = 0; index < WRITES; index += 1) bindings.writeVt(terminal, payloadText);
  });
  // vt 解析本身占了大头，单独量一次每次调用被省掉的缓冲管理开销
  measure('overhead removed: alloc+copy+free', () => {
    for (let index = 0; index < WRITES; index += 1) {
      const allocation = bindings.writeBytes(payloadBytes);
      allocation.free();
    }
  });
  // 同样的总字节数，10 帧合并成 1 次 write：sink 层 coalescing 的收益上界
  measure('coalesced x10 (same total bytes)', () => {
    for (let index = 0; index < WRITES / COALESCE_FACTOR; index += 1) {
      bindings.writeVt(terminal, coalescedBytes);
    }
  });
} finally {
  bindings.freeTerminal(terminal);
}
