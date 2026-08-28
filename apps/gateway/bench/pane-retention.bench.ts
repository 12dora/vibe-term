import { PaneRetention } from '../src/tmux-client/pane-retention';

const PANE_COUNTS = [10, 100, 500] as const;
const SEGMENT_BYTES = [1024, 16 * 1024] as const;
const EPOCH = new Uint8Array(16).fill(0x11);
const TARGET_INGESTS = 8_000;

function fmtUs(us: number): string {
  if (us >= 1_000) return `${(us / 1_000).toFixed(2)} ms`;
  return `${us.toFixed(2)} µs`;
}

function makeRetention(paneCount: number): PaneRetention {
  const retention = new PaneRetention({
    maxActivePanes: paneCount,
    maxHotPanes: paneCount,
    maxRetentionBytes: 1024 * 1024 * 1024,
    maxReplayBytesPerPane: 64 * 1024 * 1024,
    replayTtlMs: 3_600_000,
    scheduleTimers: false,
    now: () => 0,
  });
  const panes = Array.from({ length: paneCount }, (_, index) => ({
    paneId: `%${index}`,
    paneEpoch: EPOCH,
  }));
  retention.reconcilePanes(panes);
  const lease = retention.attachConsumer({ onData: () => {} });
  lease.applySubscriptions(
    1n,
    panes.map((pane) => ({ paneId: pane.paneId, paneEpoch: EPOCH, cursor: null })),
    []
  );
  return retention;
}

function runIngests(
  retention: PaneRetention,
  paneCount: number,
  segment: Uint8Array,
  count: number
): void {
  for (let index = 0; index < count; index += 1) {
    retention.ingest(`%${index % paneCount}`, EPOCH, segment);
  }
}

function measure(
  paneCount: number,
  segmentBytes: number
): {
  paneCount: number;
  segmentBytes: number;
  ingests: number;
  totalMs: number;
  usPerIngest: number;
} {
  const ingests = Math.max(paneCount, Math.ceil(TARGET_INGESTS / paneCount) * paneCount);
  const segment = new Uint8Array(segmentBytes).fill(0x61);
  const warmup = makeRetention(paneCount);
  runIngests(warmup, paneCount, segment, paneCount);
  warmup.dispose();

  const retention = makeRetention(paneCount);
  const started = performance.now();
  runIngests(retention, paneCount, segment, ingests);
  const totalMs = performance.now() - started;
  retention.dispose();
  return {
    paneCount,
    segmentBytes,
    ingests,
    totalMs,
    usPerIngest: (totalMs * 1000) / ingests,
  };
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

console.log('pane-retention ingest benchmark (active panes, scheduleTimers=false)');
console.log(
  `${pad('P', 6)} ${pad('seg', 8)} ${pad('ingests', 10)} ${pad('total', 12)} ${pad('per ingest', 14)}`
);
for (const paneCount of PANE_COUNTS) {
  for (const segmentBytes of SEGMENT_BYTES) {
    const row = measure(paneCount, segmentBytes);
    const segLabel = segmentBytes === 1024 ? '1 KiB' : '16 KiB';
    console.log(
      `${pad(String(row.paneCount), 6)} ${pad(segLabel, 8)} ${pad(String(row.ingests), 10)} ${pad(
        fmtUs(row.totalMs * 1000),
        12
      )} ${pad(fmtUs(row.usPerIngest), 14)}`
    );
  }
}
