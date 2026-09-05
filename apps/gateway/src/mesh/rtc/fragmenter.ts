import {
  DC_MAX_MESSAGE_BYTES,
  DEFAULT_FRAME_TIMEOUT_MS,
  DEFAULT_MAX_IN_FLIGHT,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FRAGMENT_SEND_MESSAGE_BYTES,
  FRAGMENT_SEND_PAYLOAD_SIZE,
  FRAME_HEADER_SIZE,
  FragmentAssembler,
  type FragmentFail,
  MAX_FRAME_PAYLOAD,
  RECEIVER_MAX_FRAGMENTS,
  fragmentBytes,
  pickFragmentPayloadSize,
} from '@tmex/shared/link';

export {
  DC_MAX_MESSAGE_BYTES,
  DEFAULT_FRAME_TIMEOUT_MS,
  DEFAULT_MAX_IN_FLIGHT,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FRAGMENT_SEND_MESSAGE_BYTES,
  FRAGMENT_SEND_PAYLOAD_SIZE,
  RECEIVER_MAX_FRAGMENTS,
};

export type FragmentSizing = { preferred: number; max: number };

export const MAX_REASSEMBLED_FRAME_BYTES = MAX_FRAME_PAYLOAD + FRAME_HEADER_SIZE;

export class FragmentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FragmentProtocolError';
  }
}

export type ReassemblerOptions = {
  timeoutMs?: number;
  maxInFlight?: number;
  now?: () => number;
  maxFrameBytes?: number;
  payloadMax?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

export function fragmentPayloadSize(maxMessageSize: number): number {
  return fragmentSizing(maxMessageSize).preferred;
}

export function fragmentSizing(maxMessageSize: number): FragmentSizing {
  if (!(maxMessageSize >= FRAGMENT_HEADER_SIZE)) {
    throw new FragmentProtocolError('datachannel maxMessageSize cannot fit fragment header');
  }
  const max = Math.min(FRAGMENT_PAYLOAD_SIZE, maxMessageSize - FRAGMENT_HEADER_SIZE);
  return { preferred: Math.min(FRAGMENT_SEND_PAYLOAD_SIZE, max), max };
}

export function fragmentFrame(
  frameId: number,
  payload: Uint8Array,
  payloadSize = FRAGMENT_SEND_PAYLOAD_SIZE,
  maxPayloadSize = FRAGMENT_PAYLOAD_SIZE
): Uint8Array[] {
  const size = pickFragmentPayloadSize(payload.byteLength, payloadSize, maxPayloadSize);
  return fragmentBytes(frameId, payload, size);
}

export class FrameReassembler {
  private readonly core: FragmentAssembler;

  constructor(opts: ReassemblerOptions = {}) {
    const maxFrameBytes = opts.maxFrameBytes ?? MAX_REASSEMBLED_FRAME_BYTES;
    const payloadMax = opts.payloadMax ?? FRAGMENT_PAYLOAD_SIZE;
    this.core = new FragmentAssembler({
      ...opts,
      maxFrameBytes,
      payloadMax,
      maxTotal: Math.max(1, Math.ceil(maxFrameBytes / FRAGMENT_SEND_PAYLOAD_SIZE)),
      refreshDeadline: true,
      setTimeoutFn: opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn:
        opts.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    });
  }

  push(chunk: Uint8Array): Uint8Array | null {
    return this.core.push(chunk, (kind, message) => this.onFail(kind, message));
  }

  sweep = (): void => this.core.sweep();
  dispose = (): void => this.core.dispose();

  private onFail(kind: FragmentFail, message: string): null {
    if (kind === 'total-exceeds' || kind === 'payload-exceeds' || kind === 'frame-too-large') {
      this.dispose();
      throw new FragmentProtocolError(message);
    }
    return null;
  }
}
