import type { EmulatorStreamListener, EmulatorStreamSource } from './pane-emulator';
import type { PaneRetentionConsumerLease, PaneScreenCheckpoint } from './pane-retention';
import type { PromptMarker } from './pane-stream-parser';

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_SCROLLBACK = 5000;
const CANONICAL_SCREEN_BYTE_LIMIT = 512 * 1024;

export type EmulatorTerminalSink = {
  write: (data: string | Uint8Array) => void;
  free: () => void;
};

export type RetentionEmulatorSource = EmulatorStreamSource & {
  getPaneIdentity: NonNullable<EmulatorStreamSource['getPaneIdentity']>;
  attachPaneConsumer: NonNullable<EmulatorStreamSource['attachPaneConsumer']>;
  captureCanonicalScreen: NonNullable<EmulatorStreamSource['captureCanonicalScreen']>;
  readPaneReplay: NonNullable<EmulatorStreamSource['readPaneReplay']>;
};

export function resolveEmulatorOptions(
  info: { cols?: number; rows?: number } | null,
  opts?: { scrollback?: number }
): { cols: number; rows: number; scrollback: number } {
  return {
    cols: info?.cols && info.cols > 0 ? info.cols : DEFAULT_COLS,
    rows: info?.rows && info.rows > 0 ? info.rows : DEFAULT_ROWS,
    scrollback: opts?.scrollback ?? DEFAULT_SCROLLBACK,
  };
}

export function hasRetentionSource(
  source: EmulatorStreamSource
): source is RetentionEmulatorSource {
  return Boolean(
    source.getPaneIdentity &&
      source.attachPaneConsumer &&
      source.captureCanonicalScreen &&
      source.readPaneReplay
  );
}

export function subscribePaneStream(
  source: EmulatorStreamSource,
  paneId: string,
  handlers: {
    onOutput?: (data: Uint8Array) => void;
    onMarker?: (marker: PromptMarker) => void;
  }
): () => void {
  const listener: EmulatorStreamListener = {};
  if (handlers.onOutput) {
    const onOutput = handlers.onOutput;
    listener.onTerminalOutput = (pid, data) => {
      if (pid === paneId) onOutput(data);
    };
  }
  if (handlers.onMarker) {
    const onMarker = handlers.onMarker;
    listener.onPromptMarker = (pid, marker) => {
      if (pid === paneId) onMarker(marker);
    };
  }
  return source.subscribe(listener);
}

export async function seedFromPaneText(
  source: EmulatorStreamSource,
  paneId: string,
  terminal: { write: (data: string) => void }
): Promise<void> {
  const seed = await source.capturePaneText(paneId, { historyLines: 0 }).catch(() => '');
  if (seed) terminal.write(`${seed.replace(/\r?\n/g, '\r\n')}\r\n`);
}

export async function seedFromRetention(
  source: EmulatorStreamSource,
  paneId: string,
  terminal: EmulatorTerminalSink,
  onData: (data: Uint8Array) => void
): Promise<PaneRetentionConsumerLease> {
  if (!hasRetentionSource(source)) {
    abortRetentionSeed(null, terminal, new Error(`pane not found: ${paneId}`));
  }
  const identity = source.getPaneIdentity(paneId);
  if (!identity) {
    abortRetentionSeed(null, terminal, new Error(`pane not found: ${paneId}`));
  }
  const lease = source.attachPaneConsumer({
    onData: (segment) => onData(segment.data),
  });
  let checkpoint: PaneScreenCheckpoint | null;
  try {
    lease.applySubscriptions(1n, [{ paneId, paneEpoch: identity.paneEpoch, cursor: null }], []);
    checkpoint = await source.captureCanonicalScreen(paneId, CANONICAL_SCREEN_BYTE_LIMIT);
  } catch (error) {
    abortRetentionSeed(lease, terminal, error);
  }
  if (!checkpoint) {
    abortRetentionSeed(lease, terminal, new Error(`pane screen unavailable: ${paneId}`));
  }
  terminal.write(checkpoint.data);
  const replay = source.readPaneReplay(paneId, {
    paneEpoch: checkpoint.paneEpoch,
    terminalSeq: checkpoint.baseSeq,
  });
  if (!replay || replay.gap) {
    abortRetentionSeed(
      lease,
      terminal,
      new Error(`pane replay unavailable after screen capture: ${paneId}`)
    );
  }
  for (const segment of replay.segments) terminal.write(segment.data);
  return lease;
}

function abortRetentionSeed(
  lease: PaneRetentionConsumerLease | null,
  terminal: { free: () => void },
  error: unknown
): never {
  lease?.close();
  terminal.free();
  throw error;
}
