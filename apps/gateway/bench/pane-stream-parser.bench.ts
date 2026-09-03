import { ControlModeUnescaper } from '../src/tmux-client/control-mode/unescape';
import { createPaneStreamParser } from '../src/tmux-client/pane-stream-parser';

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

function repeatTo(pattern: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const n = Math.min(pattern.length, size - offset);
    out.set(pattern.subarray(0, n), offset);
    offset += n;
  }
  return out;
}

function wrapTmuxPassthrough(inner: Uint8Array): Uint8Array {
  const body = new Uint8Array(inner.length * 2);
  let written = 0;
  for (const byte of inner) {
    if (byte === 0x1b) {
      body[written++] = 0x1b;
      body[written++] = 0x1b;
      continue;
    }
    body[written++] = byte;
  }
  const prefix = encoder.encode('\x1bPtmux;');
  const suffix = new Uint8Array([0x1b, 0x5c]);
  const out = new Uint8Array(prefix.length + written + suffix.length);
  out.set(prefix, 0);
  out.set(body.subarray(0, written), prefix.length);
  out.set(suffix, prefix.length + written);
  return out;
}

function wrapChunks(inner: Uint8Array, chunkSize: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let start = 0; start < inner.length; start += chunkSize) {
    const part = wrapTmuxPassthrough(
      inner.subarray(start, Math.min(start + chunkSize, inner.length))
    );
    parts.push(part);
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function noopParser() {
  return createPaneStreamParser({
    onTitle: () => {},
    onBell: () => {},
    onNotification: () => {},
    onCurrentPath: () => {},
    onPromptMarker: () => {},
    onClipboardWrite: () => {},
    onThemeSubscription: () => {},
  });
}

const plainAscii = repeatTo(
  encoder.encode('The quick brown fox jumps over the lazy dog.\r\n'),
  MIB
);

const ansiHeavy = repeatTo(
  encoder.encode('hello\x1b[1;31mworld\x1b[0m\x1b[2K\x1b[1A\x1b[32mok\x1b[0m\x1b[H'),
  MIB
);

const oscKittyClipboard = repeatTo(
  encoder.encode(
    'out\x1b]9;hello\x07more\x1b]99;i=1:d=0:p=title;Title\x1b\\\x1b]99;i=1:d=1:p=body;Body\x1b\\' +
      '\x1b]52;c;aGVsbG8=\x07\x1b]133;C\x07text\x1b]133;D;0\x07'
  ),
  MIB
);

const passthroughInner = encoder.encode('plain \x1b[1mANSI\x1b[0m \x1b]9;note\x07 done\r\n');
const passthroughHeavy = wrapChunks(repeatTo(passthroughInner, MIB), 256);

const unescapePlain = repeatTo(encoder.encode('pane output without any escapes at all\r\n'), MIB);
const unescapeEscaped = repeatTo(encoder.encode('text\\033[1mBOLD\\033[0m\\011tab\\012'), MIB);

let sink = 0;

function retain(result: Uint8Array): void {
  sink += result.length;
  if (result.length > 0) {
    sink += result[0] as number;
    sink += result[result.length - 1] as number;
  }
}

function benchParser(input: Uint8Array): () => void {
  return () => {
    retain(noopParser().push(input));
  };
}

function benchUnescape(input: Uint8Array): () => void {
  const unescaper = new ControlModeUnescaper();
  return () => {
    retain(unescaper.unescape(input, 0));
  };
}

type BenchRow = {
  name: string;
  bytes: number;
  iters: number;
  ms: number;
  mbps: number;
  heapDeltaMB: number;
  heapDeltaPerIterMB: number;
};

function gc(): void {
  const bunGc = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc;
  bunGc?.(true);
}

function runBench(name: string, inputBytes: number, fn: () => void, targetMs = 400): BenchRow {
  for (let i = 0; i < 5; i += 1) {
    fn();
  }
  const tProbe = performance.now();
  fn();
  const probeMs = Math.max(performance.now() - tProbe, 0.05);
  const iters = Math.max(4, Math.min(80, Math.ceil(targetMs / probeMs)));

  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    fn();
  }
  const ms = performance.now() - t0;
  const heapAfter = process.memoryUsage().heapUsed;
  const totalMB = (inputBytes * iters) / MIB;
  const heapDeltaMB = (heapAfter - heapBefore) / MIB;
  return {
    name,
    bytes: inputBytes,
    iters,
    ms,
    mbps: totalMB / (ms / 1000),
    heapDeltaMB,
    heapDeltaPerIterMB: heapDeltaMB / iters,
  };
}

function fmt(row: BenchRow): string {
  return [
    row.name.padEnd(28),
    `${(row.bytes / MIB).toFixed(2)}MiB`.padStart(8),
    `x${row.iters}`.padStart(5),
    `${row.ms.toFixed(1)}ms`.padStart(10),
    `${row.mbps.toFixed(1)} MB/s`.padStart(14),
    `${row.heapDeltaPerIterMB.toFixed(2)} MiB/iter`.padStart(16),
  ].join('  ');
}

const rows: BenchRow[] = [
  runBench('parser/plain-ascii', plainAscii.length, benchParser(plainAscii)),
  runBench('parser/ansi-heavy', ansiHeavy.length, benchParser(ansiHeavy)),
  runBench('parser/osc-kitty-clipboard', oscKittyClipboard.length, benchParser(oscKittyClipboard)),
  runBench('parser/tmux-passthrough', passthroughHeavy.length, benchParser(passthroughHeavy)),
  runBench('unescape/unescaped', unescapePlain.length, benchUnescape(unescapePlain)),
  runBench('unescape/escaped', unescapeEscaped.length, benchUnescape(unescapeEscaped)),
];

console.log('pane-stream-parser bench');
console.log(
  [
    'name'.padEnd(28),
    'input'.padStart(8),
    'iters'.padStart(5),
    'time'.padStart(10),
    'throughput'.padStart(14),
    'heap (rough)'.padStart(16),
  ].join('  ')
);
for (const row of rows) {
  console.log(fmt(row));
}
console.log(JSON.stringify({ sink, rows }, null, 2));
