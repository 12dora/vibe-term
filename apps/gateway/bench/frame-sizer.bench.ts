import { CanonicalFrameSizer } from '../src/ws/canonical/frame-sizer';
import { CanonicalPaneStream } from '../src/ws/canonical/pane-stream';
import { CanonicalTransactionSender } from '../src/ws/canonical/transaction-sender';
import type { CanonicalEvent, CanonicalSendResult } from '../src/ws/canonical/types';

const CAPS = [4 * 1024, 64 * 1024, 1024 * 1024] as const;
const PANE = {
  deviceId: 'device-a',
  serverEpoch: new Uint8Array(16).fill(0x11),
  paneId: '%1',
};
const PANE_EPOCH = new Uint8Array(16).fill(0x22);
const MAX_PANE_ITERS = 40;
const SEND_ITERS = 20;

class CountingSizer extends CanonicalFrameSizer {
  fitChecks = 0;

  eventFits(event: CanonicalEvent): boolean {
    this.fitChecks += 1;
    return super.eventFits(event);
  }
}

function fmtNs(ns: number): string {
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(2)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(2)} µs`;
  return `${ns.toFixed(0)} ns`;
}

function benchMaxPane(cap: number): {
  coldNs: number;
  hotNs: number;
  coldFits: number;
  hotFits: number;
  maxData: number;
} {
  const coldSizer = new CountingSizer(cap);
  const coldStart = performance.now();
  const maxData = coldSizer.maxPaneDataBytes(PANE, PANE_EPOCH);
  const coldNs = (performance.now() - coldStart) * 1e6;

  const hotSizer = new CountingSizer(cap);
  hotSizer.maxPaneDataBytes(PANE, PANE_EPOCH);
  hotSizer.fitChecks = 0;
  const hotStart = performance.now();
  for (let i = 0; i < MAX_PANE_ITERS; i += 1) {
    hotSizer.maxPaneDataBytes(PANE, PANE_EPOCH);
  }
  const hotNs = ((performance.now() - hotStart) * 1e6) / MAX_PANE_ITERS;
  return {
    coldNs,
    hotNs,
    coldFits: coldSizer.fitChecks,
    hotFits: hotSizer.fitChecks / MAX_PANE_ITERS,
    maxData,
  };
}

function createStream(
  cap: number,
  sizer: CanonicalFrameSizer,
  sendEvent: (event: CanonicalEvent) => CanonicalSendResult
): CanonicalPaneStream {
  const sender = new CanonicalTransactionSender({
    sizer,
    sendEvent,
    isClosed: () => false,
    getServerEpoch: () => PANE.serverEpoch,
  });
  return new CanonicalPaneStream({
    sender,
    getServerEpoch: () => PANE.serverEpoch,
    maxPendingPaneGaps: 8,
    onPendingWork: () => {},
  });
}

function benchSendPane(cap: number): {
  nsPerCall: number;
  fitsPerCall: number;
  delivered: number;
} {
  const payload = new Uint8Array(Math.min(cap, 64 * 1024)).fill(0x61);
  const sizer = new CountingSizer(cap);
  const stream = createStream(cap, sizer, () => true);
  stream.sendPaneData('device-a', {
    paneId: PANE.paneId,
    paneEpoch: PANE_EPOCH,
    seqStart: 0n,
    seqEnd: BigInt(payload.byteLength),
    data: payload,
  });
  sizer.fitChecks = 0;
  const start = performance.now();
  let delivered = 0;
  for (let i = 0; i < SEND_ITERS; i += 1) {
    const ok = stream.sendPaneData('device-a', {
      paneId: PANE.paneId,
      paneEpoch: PANE_EPOCH,
      seqStart: BigInt(i * payload.byteLength),
      seqEnd: BigInt((i + 1) * payload.byteLength),
      data: payload,
    });
    if (ok) delivered += 1;
  }
  const elapsedMs = performance.now() - start;
  return {
    nsPerCall: (elapsedMs * 1e6) / SEND_ITERS,
    fitsPerCall: sizer.fitChecks / SEND_ITERS,
    delivered,
  };
}

console.log('frame-sizer bench');
console.log(`iters maxPaneHot=${MAX_PANE_ITERS} sendPane=${SEND_ITERS}`);
console.log('fitChecks = CanonicalFrameSizer.eventFits calls (0 after exact sizing + sendFitted)');
for (const cap of CAPS) {
  const maxPane = benchMaxPane(cap);
  console.log(
    `maxPaneDataBytes cap=${String(cap).padStart(8)}  cold=${fmtNs(maxPane.coldNs).padStart(12)} (fits=${maxPane.coldFits})  hot=${fmtNs(maxPane.hotNs).padStart(12)}/call (fits=${maxPane.hotFits.toFixed(2)})  maxData=${maxPane.maxData}`
  );
  const send = benchSendPane(cap);
  console.log(
    `sendPaneData     cap=${String(cap).padStart(8)}  ${fmtNs(send.nsPerCall).padStart(12)}/call  fits=${send.fitsPerCall.toFixed(2)}  delivered=${send.delivered}`
  );
}
