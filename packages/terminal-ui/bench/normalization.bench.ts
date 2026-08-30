// live 输出补 CR 的两种实现：旧版先数一遍 CR、再分配、再抄一遍（两趟 + 每块一次分配），
// 现实现单趟写进常驻暂存区，无裸 LF 时零拷贝原样返回。
// 运行：bun packages/terminal-ui/bench/normalization.bench.ts
import { normalizeLiveOutputForTerminal } from '../src/components/normalization';

const TOTAL_BYTES = 10 * 1024 * 1024;
const CHUNKS = 320;
const CHUNK_BYTES = TOTAL_BYTES / CHUNKS;
const WARMUP_ROUNDS = 3;
const MEASURED_ROUNDS = 10;

function makeChunk(pattern: string): Uint8Array {
  const unit = new TextEncoder().encode(pattern);
  const chunk = new Uint8Array(CHUNK_BYTES);
  for (let index = 0; index < chunk.length; index += 1)
    chunk[index] = unit[index % unit.length] ?? 0;
  return chunk;
}

function legacyNormalize(
  data: Uint8Array,
  previousEndedWithCR: boolean
): { normalized: Uint8Array; endedWithCR: boolean } {
  let prevWasCR = previousEndedWithCR;
  let extraCRCount = 0;
  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) extraCRCount += 1;
    prevWasCR = byte === 0x0d;
  }
  const endedWithCR = prevWasCR;
  if (extraCRCount === 0) return { normalized: data, endedWithCR };

  const normalized = new Uint8Array(data.length + extraCRCount);
  let writeIndex = 0;
  prevWasCR = previousEndedWithCR;
  for (const byte of data) {
    if (byte === 0x0a && !prevWasCR) {
      normalized[writeIndex] = 0x0d;
      writeIndex += 1;
    }
    normalized[writeIndex] = byte;
    writeIndex += 1;
    prevWasCR = byte === 0x0d;
  }
  return { normalized, endedWithCR };
}

type Normalize = typeof normalizeLiveOutputForTerminal;

function measure(label: string, chunk: Uint8Array, normalize: Normalize): void {
  const run = (): number => {
    let endedWithCR = false;
    let bytes = 0;
    for (let index = 0; index < CHUNKS; index += 1) {
      const result = normalize(chunk, endedWithCR);
      endedWithCR = result.endedWithCR;
      bytes += result.normalized.byteLength;
    }
    return bytes;
  };

  for (let round = 0; round < WARMUP_ROUNDS; round += 1) run();
  const samples: number[] = [];
  let bytes = 0;
  for (let round = 0; round < MEASURED_ROUNDS; round += 1) {
    const started = performance.now();
    bytes = run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(
    `${label.padEnd(30)} median ${median.toFixed(1).padStart(7)} ms  out=${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  );
}

console.log(
  `normalization: ${TOTAL_BYTES / (1024 * 1024)} MiB in ${CHUNKS} x ${CHUNK_BYTES / 1024} KiB chunks`
);
for (const [name, pattern] of [
  ['bare LF (y\\n)', 'y\n'],
  ['already CRLF', 'y\r\n'],
] as const) {
  const chunk = makeChunk(pattern);
  measure(`${name} legacy`, chunk, legacyNormalize);
  measure(`${name} current`, chunk, normalizeLiveOutputForTerminal);
}
