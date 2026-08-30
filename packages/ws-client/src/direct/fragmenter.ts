import {
  DC_MAX_MESSAGE_BYTES,
  DEFAULT_FRAME_TIMEOUT_MS,
  DEFAULT_MAX_IN_FLIGHT,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FragmentAssembler,
  type FragmentFail,
  fragmentBytes,
} from '@tmex/shared/link';

export const MAX_DC_MESSAGE_BYTES = DC_MAX_MESSAGE_BYTES;
export {
  DEFAULT_FRAME_TIMEOUT_MS,
  DEFAULT_MAX_IN_FLIGHT,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
};

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_FRAGMENTS_PER_FRAME = Math.ceil(MAX_FRAME_BYTES / FRAGMENT_PAYLOAD_SIZE);
export const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export type FragmentViolation =
  | 'chunk-too-short'
  | 'chunk-too-large'
  | 'bad-total'
  | 'bad-index'
  | 'frame-too-large'
  | 'pending-bytes-exceeded';

const FAIL_TO_VIOLATION: Record<FragmentFail, FragmentViolation> = {
  short: 'chunk-too-short',
  'chunk-too-large': 'chunk-too-large',
  'total-zero': 'bad-total',
  'total-exceeds': 'bad-total',
  'bad-index': 'bad-index',
  'payload-exceeds': 'chunk-too-large',
  'frame-too-large': 'frame-too-large',
  'pending-exceeded': 'pending-bytes-exceeded',
};

export type ReassemblerOptions = {
  timeoutMs?: number;
  maxInFlight?: number;
  maxFrameBytes?: number;
  maxPendingBytes?: number;
  maxMessageBytes?: number;
  now?: () => number;
  onViolation?: (reason: FragmentViolation) => void;
};

export class FragmentBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentBoundsError';
  }
}

export function effectiveFragmentPayloadSize(maxMessageBytes?: number | null): number {
  if (typeof maxMessageBytes !== 'number' || !Number.isFinite(maxMessageBytes)) {
    return FRAGMENT_PAYLOAD_SIZE;
  }
  const usable = Math.floor(maxMessageBytes) - FRAGMENT_HEADER_SIZE;
  if (usable <= 0) return FRAGMENT_PAYLOAD_SIZE;
  return Math.min(FRAGMENT_PAYLOAD_SIZE, usable);
}

export function fragmentFrame(
  frameId: number,
  payload: Uint8Array,
  payloadSize = FRAGMENT_PAYLOAD_SIZE
): Uint8Array[] {
  if (payloadSize < 1 || payloadSize > FRAGMENT_PAYLOAD_SIZE) {
    throw new FragmentBoundsError(`fragment payload size out of range: ${payloadSize}`);
  }
  if (payload.byteLength > MAX_FRAME_BYTES) {
    throw new FragmentBoundsError(`frame too large: ${payload.byteLength} > ${MAX_FRAME_BYTES}`);
  }
  const total = Math.max(1, Math.ceil(payload.byteLength / payloadSize));
  if (total > MAX_FRAGMENTS_PER_FRAME) {
    throw new FragmentBoundsError(`too many fragments: ${total} > ${MAX_FRAGMENTS_PER_FRAME}`);
  }
  return fragmentBytes(frameId, payload, payloadSize);
}

export class FrameReassembler {
  private readonly core: FragmentAssembler;
  private readonly onViolation: ((reason: FragmentViolation) => void) | null;

  constructor(options: ReassemblerOptions = {}) {
    this.onViolation = options.onViolation ?? null;
    this.core = new FragmentAssembler({
      timeoutMs: options.timeoutMs,
      maxInFlight: options.maxInFlight,
      now: options.now,
      maxFrameBytes: options.maxFrameBytes ?? MAX_FRAME_BYTES,
      maxTotal: MAX_FRAGMENTS_PER_FRAME,
      maxMessageBytes: options.maxMessageBytes ?? MAX_DC_MESSAGE_BYTES,
      maxPendingBytes: options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      refreshDeadline: false,
    });
  }

  get bufferedBytes(): number {
    return this.core.pendingBytes;
  }
  push(chunk: Uint8Array): Uint8Array | null {
    return this.core.push(chunk, (kind) => {
      this.onViolation?.(FAIL_TO_VIOLATION[kind]);
      return null;
    });
  }
  sweep = (): void => this.core.sweep();
  clear = (): void => this.core.clear();
}
