import type { GatewayPaneHistoryPage, GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import { HeadlessTerminal } from 'ghostty-terminal/headless';
import {
  normalizeHistoryForTerminal,
  normalizeLiveOutputForTerminal,
} from '../src/components/normalization';
import {
  NORMAL_SCREEN_PREFIX,
  buildCanonicalSnapshotPayload,
  startsWithBytes,
} from '../src/components/terminal-snapshot';

// history 分页的整屏重写代价：gateway 自新到旧回溯，第 i 页到达时终端必须重排前 i 页，
// 因此单次到达的代价是 O(i)，一次滚到底的总代价是 O(P^2)。这里量化两种重写实现的差距。
const PAGE_COUNT = 64;
const PAGE_BYTES = 128 * 1024;
const COLS = 80;
const ROWS = 24;

const encoder = new TextEncoder();

function makePageBody(index: number): string {
  const line = `${String(index).padStart(4, '0')} ${'x'.repeat(COLS - 5)}\n`;
  return line.repeat(Math.ceil(PAGE_BYTES / line.length));
}

function makePage(index: number): GatewayPaneHistoryPage {
  const lineEnd = (PAGE_COUNT - index) * ROWS;
  return {
    deviceId: 'bench',
    paneId: '%1',
    paneEpoch: new Uint8Array([1]),
    historyEpoch: new Uint8Array([2]),
    lineStart: lineEnd - ROWS,
    lineEnd,
    truncated: false,
    data: encoder.encode(makePageBody(index)),
    nextCursor: null,
  };
}

const snapshot: GatewayPaneScreenSnapshot = {
  deviceId: 'bench',
  paneId: '%1',
  paneEpoch: new Uint8Array([1]),
  baseSeq: 0n,
  rows: ROWS,
  cols: COLS,
  modes: 0,
  data: encoder.encode(`\x1b[2J\x1b[H${'live line\n'.repeat(ROWS)}`),
  historyCursor: null,
};

interface CountingTerminal {
  calls: number;
  bytes: number;
  write(data: string | Uint8Array): void;
}

function createTerminal(): CountingTerminal {
  return {
    calls: 0,
    bytes: 0,
    write(data) {
      this.calls += 1;
      this.bytes += typeof data === 'string' ? encoder.encode(data).byteLength : data.byteLength;
    },
  };
}

// 改动前的重写路径：清屏前缀 / 每页正文 / 每页换行 / 快照正文各发一次 write，
// 且每次重排都对全部历史页重新 decode + 正则规范化。
function writeLegacy(
  terminal: CountingTerminal,
  historyPages: readonly GatewayPaneHistoryPage[]
): void {
  const body = normalizeLiveOutputForTerminal(
    startsWithBytes(snapshot.data, NORMAL_SCREEN_PREFIX) && historyPages.length > 0
      ? snapshot.data.subarray(NORMAL_SCREEN_PREFIX.byteLength)
      : snapshot.data,
    false
  ).normalized;
  if (historyPages.length === 0) {
    terminal.write(body);
    return;
  }
  terminal.write(NORMAL_SCREEN_PREFIX);
  const decoder = new TextDecoder();
  for (const page of historyPages) {
    terminal.write(normalizeHistoryForTerminal(decoder.decode(page.data)));
    terminal.write('\r\n');
  }
  terminal.write(body);
}

function writeBatched(
  terminal: CountingTerminal,
  historyPages: readonly GatewayPaneHistoryPage[]
): void {
  terminal.write(buildCanonicalSnapshotPayload(snapshot, historyPages));
}

interface BenchResult {
  label: string;
  calls: number;
  bytes: number;
  elapsedMs: number;
}

function run(
  label: string,
  write: (terminal: CountingTerminal, pages: readonly GatewayPaneHistoryPage[]) => void
): BenchResult {
  const pages = Array.from({ length: PAGE_COUNT }, (_, index) => makePage(index));
  const terminal = createTerminal();
  const accumulated: GatewayPaneHistoryPage[] = [];
  const started = performance.now();
  for (const page of pages) {
    accumulated.unshift(page);
    write(terminal, accumulated);
  }
  const elapsedMs = performance.now() - started;
  return { label, calls: terminal.calls, bytes: terminal.bytes, elapsedMs };
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function report(results: readonly BenchResult[]): void {
  for (const result of results) {
    console.log(
      `${result.label.padEnd(18)} calls=${String(result.calls).padStart(6)}  ` +
        `bytes=${mib(result.bytes).padStart(10)}  time=${result.elapsedMs.toFixed(1).padStart(8)} ms`
    );
  }
}

console.log(`history paging: ${PAGE_COUNT} pages x ${PAGE_BYTES / 1024} KiB, ${COLS}x${ROWS}`);
run('warmup', writeBatched);
run('warmup', writeLegacy);
report([run('legacy (per-page)', writeLegacy), run('batched (current)', writeBatched)]);

// 真实 ghostty parser 下的分页重排：TerminalSurface 现在把成串到达的页攒到一个
// 显示帧窗口再重建一次，这里对比逐页重建与整批一次重建的解析耗时。
// RIS：HeadlessTerminal 没有 reset()，用整机复位序列等价替代 writeCanonicalSnapshot 的 reset
const RIS = '\x1bc';
const REPLAY_PAGES = 22;
const REPLAY_PAGE_BYTES = 126 * 1024;

function makeReplayPage(index: number): GatewayPaneHistoryPage {
  const line = `${String(index).padStart(4, '0')} ${'x'.repeat(COLS - 5)}\n`;
  const body = line.repeat(Math.ceil(REPLAY_PAGE_BYTES / line.length));
  const lineEnd = (REPLAY_PAGES - index) * ROWS;
  return { ...makePage(index), lineStart: lineEnd - ROWS, lineEnd, data: encoder.encode(body) };
}

async function replay(
  label: string,
  pages: readonly GatewayPaneHistoryPage[],
  perPage: boolean
): Promise<void> {
  const terminal = await HeadlessTerminal.create({ cols: COLS, rows: ROWS, scrollback: 10_000 });
  const accumulated: GatewayPaneHistoryPage[] = [];
  const started = performance.now();
  for (const page of pages) {
    accumulated.unshift(page);
    if (!perPage && page !== pages[pages.length - 1]) continue;
    terminal.write(RIS);
    terminal.write(buildCanonicalSnapshotPayload(snapshot, accumulated));
  }
  const elapsedMs = performance.now() - started;
  terminal.free();
  console.log(`${label.padEnd(30)} ${elapsedMs.toFixed(1).padStart(8)} ms`);
}

const replayPages = Array.from({ length: REPLAY_PAGES }, (_, index) => makeReplayPage(index));
console.log(`\nghostty replay: ${REPLAY_PAGES} pages x ${REPLAY_PAGE_BYTES / 1024} KiB`);
await replay('warmup', replayPages, false);
await replay('per-page rebuild', replayPages, true);
await replay('batched rebuild', replayPages, false);
