import { heapStats } from 'bun:jsc';

import { createControlModeSubscription } from '../src/tmux-client/control-mode-subscription';

const encoder = new TextEncoder();
const EVENT_BYTES = 4 * 1024;

type Case = {
  name: string;
  line: Uint8Array;
};

type Mode = {
  name: string;
  materializeOutput: boolean;
};

function repeatToLine(pattern: string): Uint8Array {
  const prefix = '%output %1 ';
  const suffix = '\n';
  const repeats = Math.ceil((EVENT_BYTES - prefix.length - suffix.length) / pattern.length);
  const payload = pattern.repeat(repeats).slice(0, EVENT_BYTES - prefix.length - suffix.length);
  return encoder.encode(`${prefix}${payload}${suffix}`);
}

const cases: Case[] = [
  { name: 'plain', line: repeatToLine('plain terminal output ') },
  { name: 'sgr-dense', line: repeatToLine('x\\033[1;31mred\\033[0m') },
  {
    name: 'mixed',
    line: repeatToLine('text\\033[32mok\\033[0m\\033]9;done\\007more '),
  },
];

const modes: Mode[] = [
  { name: 'materialized', materializeOutput: true },
  { name: 'notifications-only', materializeOutput: false },
];

let sink = 0;

function createSubscription(materializeOutput: boolean) {
  return createControlModeSubscription(
    {
      onTerminalOutput: (_paneId, data) => {
        sink += data.byteLength;
      },
      onTitle: () => {},
      onBell: () => {},
      onNotification: () => {},
      onStructureChanged: () => {},
      onExit: () => {},
    },
    { materializeOutput: () => materializeOutput }
  );
}

function measureNsPerEvent(item: Case, mode: Mode): number {
  const subscription = createSubscription(mode.materializeOutput);
  for (let index = 0; index < 200; index += 1) subscription.push(item.line);

  const probeStart = Bun.nanoseconds();
  for (let index = 0; index < 100; index += 1) subscription.push(item.line);
  const probeNs = Math.max(Bun.nanoseconds() - probeStart, 1);
  const iterations = Math.max(1_000, Math.min(100_000, Math.ceil(500_000_000 / (probeNs / 100))));

  const started = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) subscription.push(item.line);
  const nsPerEvent = (Bun.nanoseconds() - started) / iterations;
  subscription.dispose();
  return nsPerEvent;
}

function measureTypedArrayAllocationsPerEvent(item: Case, mode: Mode): number {
  const subscription = createSubscription(mode.materializeOutput);
  for (let index = 0; index < 200; index += 1) subscription.push(item.line);

  const OriginalUint8Array = Uint8Array;
  let allocations = 0;
  const CountingUint8Array = new Proxy(OriginalUint8Array, {
    construct(target, args, newTarget) {
      allocations += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  Object.defineProperty(globalThis, 'Uint8Array', {
    configurable: true,
    writable: true,
    value: CountingUint8Array,
  });
  const iterations = 1_000;
  try {
    for (let index = 0; index < iterations; index += 1) subscription.push(item.line);
  } finally {
    Object.defineProperty(globalThis, 'Uint8Array', {
      configurable: true,
      writable: true,
      value: OriginalUint8Array,
    });
    subscription.dispose();
  }
  return allocations / iterations;
}

function currentUint8ArrayCount(): number {
  return heapStats().objectTypeCounts.Uint8Array ?? 0;
}

function measureTransientUint8ArraysPerEvent(item: Case, mode: Mode): number {
  const subscription = createSubscription(mode.materializeOutput);
  for (let index = 0; index < 200; index += 1) subscription.push(item.line);

  Bun.gc(true);
  const calibrationBefore = currentUint8ArrayCount();
  const calibrationAfter = currentUint8ArrayCount();
  const measurementOverhead = calibrationAfter - calibrationBefore;
  Bun.gc(true);
  const before = currentUint8ArrayCount();
  const iterations = 10;
  for (let index = 0; index < iterations; index += 1) subscription.push(item.line);
  const after = currentUint8ArrayCount();
  subscription.dispose();
  return Math.max(0, (after - before - measurementOverhead) / iterations);
}

console.log('control output pipeline bench');
console.log(
  'case        mode                  ns/event  ns/input-byte  backing-u8/event  transient-u8/event'
);
for (const item of cases) {
  for (const mode of modes) {
    const nsPerEvent = measureNsPerEvent(item, mode);
    const allocations = measureTypedArrayAllocationsPerEvent(item, mode);
    const transient = measureTransientUint8ArraysPerEvent(item, mode);
    console.log(
      `${item.name.padEnd(10)} ${mode.name.padEnd(18)} ${nsPerEvent
        .toFixed(1)
        .padStart(9)} ${(nsPerEvent / item.line.byteLength).toFixed(2).padStart(14)} ${allocations
        .toFixed(2)
        .padStart(17)} ${transient.toFixed(2).padStart(19)}`
    );
  }
}
console.log(`sink=${sink}`);
