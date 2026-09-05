import { describe, expect, test } from 'bun:test';
import { FragmentAssembler, fragmentBytes } from '@tmex/shared/link';
import {
  DC_MAX_MESSAGE_BYTES,
  FRAGMENT_HEADER_SIZE,
  FRAGMENT_PAYLOAD_SIZE,
  FRAGMENT_SEND_MESSAGE_BYTES,
  FRAGMENT_SEND_PAYLOAD_SIZE,
  FragmentProtocolError,
  FrameReassembler,
  MAX_REASSEMBLED_FRAME_BYTES,
  RECEIVER_MAX_FRAGMENTS,
  fragmentFrame,
  fragmentPayloadSize,
  fragmentSizing,
} from './fragmenter';

function makeFrag(frameId: number, idx: number, total: number, payloadLen: number): Uint8Array {
  const out = new Uint8Array(FRAGMENT_HEADER_SIZE + payloadLen);
  out[0] = frameId & 0xff;
  out[1] = (frameId >>> 8) & 0xff;
  out[2] = (frameId >>> 16) & 0xff;
  out[3] = (frameId >>> 24) & 0xff;
  out[4] = idx & 0xff;
  out[5] = (idx >>> 8) & 0xff;
  out[6] = total & 0xff;
  out[7] = (total >>> 8) & 0xff;
  return out;
}

describe('fragmentFrame', () => {
  test('empty payload is a single header-only fragment', () => {
    const parts = fragmentFrame(7, new Uint8Array(0));
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE);
    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toEqual(new Uint8Array(0));
  });

  test('payload under the protocol payload cap is a single fragment', () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const parts = fragmentFrame(1, payload);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 4);
    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toEqual(payload);
  });

  test('sends 16 KiB messages while retaining the 64 KiB receive cap', () => {
    expect(DC_MAX_MESSAGE_BYTES).toBe(64 * 1024);
    expect(FRAGMENT_PAYLOAD_SIZE).toBe(DC_MAX_MESSAGE_BYTES - FRAGMENT_HEADER_SIZE);
    expect(FRAGMENT_SEND_MESSAGE_BYTES).toBe(16 * 1024);
    expect(FRAGMENT_HEADER_SIZE + FRAGMENT_SEND_PAYLOAD_SIZE).toBe(FRAGMENT_SEND_MESSAGE_BYTES);
    const exact = fragmentFrame(1, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE).fill(1));
    expect(exact).toHaveLength(1);
    expect(exact[0]?.byteLength).toBe(16 * 1024);
    const over = fragmentFrame(2, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(2));
    expect(over).toHaveLength(2);
    expect(over[0]?.byteLength).toBe(16 * 1024);
    expect(over[1]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 1);
  });

  test('effective payload is min(protocol cap, channel.maxMessageSize - 8)', () => {
    expect(fragmentPayloadSize(DC_MAX_MESSAGE_BYTES)).toBe(FRAGMENT_SEND_PAYLOAD_SIZE);
    expect(fragmentPayloadSize(32 * 1024)).toBe(FRAGMENT_SEND_PAYLOAD_SIZE);
    expect(fragmentPayloadSize(8 * 1024)).toBe(8 * 1024 - FRAGMENT_HEADER_SIZE);
    expect(() => fragmentPayloadSize(FRAGMENT_HEADER_SIZE - 1)).toThrow(FragmentProtocolError);
  });

  test('reassembles legacy 64 KiB fragments', () => {
    const payload = new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1).fill(7);
    const parts = fragmentFrame(3, payload, FRAGMENT_PAYLOAD_SIZE);
    expect(parts).toHaveLength(2);
    expect(parts[0]?.byteLength).toBe(DC_MAX_MESSAGE_BYTES);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(parts[1] as Uint8Array)).toEqual(payload);
  });

  test('payload larger than the send target is split with idx/total', () => {
    const payload = new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE * 2 + 10);
    payload[0] = 9;
    payload[FRAGMENT_SEND_PAYLOAD_SIZE] = 8;
    payload[payload.byteLength - 1] = 7;
    const parts = fragmentFrame(42, payload);
    expect(parts).toHaveLength(3);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_SEND_MESSAGE_BYTES);
    expect(parts[2]?.byteLength).toBe(FRAGMENT_HEADER_SIZE + 10);

    const assembled = new FrameReassembler();
    expect(assembled.push(parts[0] as Uint8Array)).toBeNull();
    expect(assembled.push(parts[2] as Uint8Array)).toBeNull();
    expect(assembled.push(parts[1] as Uint8Array)).toEqual(payload);
  });
});

describe('FrameReassembler', () => {
  test('reassembles out-of-order fragments of concurrent frames', () => {
    const a = fragmentFrame(1, new Uint8Array([1, 1, 1]));
    const bPayload = new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(2);
    const b = fragmentFrame(2, bPayload);
    const reassembler = new FrameReassembler();
    expect(reassembler.push(b[1] as Uint8Array)).toBeNull();
    expect(reassembler.push(a[0] as Uint8Array)).toEqual(new Uint8Array([1, 1, 1]));
    expect(reassembler.push(b[0] as Uint8Array)).toEqual(bPayload);
  });

  test('drops a frame that exceeds the per-frame timeout', () => {
    let now = 1_000;
    const reassembler = new FrameReassembler({ now: () => now, timeoutMs: 50, maxInFlight: 8 });
    const parts = fragmentFrame(3, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1));
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    now = 1_060;
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
  });

  test('a slow trickle of fragments does not drop an in-progress frame', () => {
    let now = 0;
    const reassembler = new FrameReassembler({ now: () => now, timeoutMs: 50, maxInFlight: 8 });
    const payload = new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE * 2 + 4).fill(6);
    const parts = fragmentFrame(5, payload);
    expect(parts).toHaveLength(3);
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    now = 40;
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
    now = 80;
    expect(reassembler.push(parts[2] as Uint8Array)).toEqual(payload);
  });

  test('evicts the oldest in-flight frame when the cap is hit', () => {
    const reassembler = new FrameReassembler({ maxInFlight: 2, timeoutMs: 60_000 });
    const a = fragmentFrame(1, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(1));
    const b = fragmentFrame(2, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(2));
    const c = fragmentFrame(3, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(3));
    expect(reassembler.push(a[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(b[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(c[0] as Uint8Array)).toBeNull();
    expect(reassembler.push(a[1] as Uint8Array)).toBeNull();
    expect(reassembler.push(c[1] as Uint8Array)).toEqual(
      new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(3)
    );
  });

  test('ignores truncated headers and inconsistent totals', () => {
    const reassembler = new FrameReassembler();
    expect(reassembler.push(new Uint8Array([1, 2, 3]))).toBeNull();
    const parts = fragmentFrame(9, new Uint8Array([4, 5]));
    const bad = (parts[0] as Uint8Array).slice();
    bad[6] = 9;
    bad[7] = 0;
    expect(reassembler.push(bad)).toBeNull();
    expect(reassembler.push(parts[0] as Uint8Array)).toEqual(new Uint8Array([4, 5]));
  });

  test('rejects total above ceil(1 MiB / payloadMax)', () => {
    const reassembler = new FrameReassembler();
    const maxTotal = Math.ceil(MAX_REASSEMBLED_FRAME_BYTES / FRAGMENT_SEND_PAYLOAD_SIZE);
    const chunk = fragmentFrame(1, new Uint8Array([1]))[0] as Uint8Array;
    const over = chunk.slice();
    const total = maxTotal + 1;
    over[6] = total & 0xff;
    over[7] = (total >>> 8) & 0xff;
    expect(() => reassembler.push(over)).toThrow(FragmentProtocolError);
  });

  test('rejects a fragment whose payload exceeds payloadMax', () => {
    const reassembler = new FrameReassembler();
    const oversized = fragmentBytes(
      1,
      new Uint8Array(FRAGMENT_PAYLOAD_SIZE + 1),
      FRAGMENT_PAYLOAD_SIZE + 1
    );
    expect(() => reassembler.push(oversized[0] as Uint8Array)).toThrow(FragmentProtocolError);
  });

  test('reassembles a max mux DATA frame (1 MiB payload plus 10-byte header)', () => {
    const payload = new Uint8Array(1024 * 1024 + 10).fill(9);
    const parts = fragmentFrame(1, payload);
    const reassembler = new FrameReassembler();
    let out: Uint8Array | null = null;
    for (const part of parts) {
      out = reassembler.push(part);
    }
    expect(out).toEqual(payload);
  });

  test('rejects a frame whose cumulative payload exceeds 1 MiB', () => {
    const reassembler = new FrameReassembler();
    const maxTotal = Math.ceil(MAX_REASSEMBLED_FRAME_BYTES / FRAGMENT_SEND_PAYLOAD_SIZE);
    const full = maxTotal - 1;
    for (let idx = 0; idx < full; idx++) {
      expect(reassembler.push(makeFrag(1, idx, maxTotal, FRAGMENT_SEND_PAYLOAD_SIZE))).toBeNull();
    }
    const remaining = MAX_REASSEMBLED_FRAME_BYTES - full * FRAGMENT_SEND_PAYLOAD_SIZE;
    expect(() => reassembler.push(makeFrag(1, full, maxTotal, remaining + 1))).toThrow(
      FragmentProtocolError
    );
  });

  test('sweeps expired partial frames on a timer without waiting for push', async () => {
    const reassembler = new FrameReassembler({ timeoutMs: 20 });
    const parts = fragmentFrame(3, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1));
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
  });

  test('dispose clears pending frames so a later fragment cannot complete them', () => {
    const reassembler = new FrameReassembler();
    const parts = fragmentFrame(4, new Uint8Array(FRAGMENT_SEND_PAYLOAD_SIZE + 1).fill(4));
    expect(reassembler.push(parts[0] as Uint8Array)).toBeNull();
    reassembler.dispose();
    expect(reassembler.push(parts[1] as Uint8Array)).toBeNull();
  });
});

// packages/ws-client/src/direct/fragmenter.ts 的接收端配置（含现网旧浏览器）。
function browserReassembler() {
  return new FragmentAssembler({
    maxFrameBytes: 1024 * 1024,
    maxTotal: RECEIVER_MAX_FRAGMENTS,
    maxMessageBytes: DC_MAX_MESSAGE_BYTES,
    refreshDeadline: false,
  });
}

describe('browser fragment count cap', () => {
  test('a 301,581-byte watch notification stays within the browser 17-fragment limit', () => {
    const payload = new Uint8Array(301_581);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
    const sizing = fragmentSizing(DC_MAX_MESSAGE_BYTES);
    const parts = fragmentFrame(11, payload, sizing.preferred, sizing.max);
    expect(parts.length).toBeLessThanOrEqual(RECEIVER_MAX_FRAGMENTS);
    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(DC_MAX_MESSAGE_BYTES);

    const browser = browserReassembler();
    let browserOut: Uint8Array | null = null;
    for (const part of parts) {
      browserOut = browser.push(part, (kind, message) => {
        throw new Error(`${kind}: ${message}`);
      });
    }
    expect(browserOut).toEqual(payload);

    const gateway = new FrameReassembler();
    let gatewayOut: Uint8Array | null = null;
    for (const part of parts) gatewayOut = gateway.push(part);
    expect(gatewayOut).toEqual(payload);
  });

  test('every frame up to the mux maximum fits the browser limit', () => {
    const sizing = fragmentSizing(DC_MAX_MESSAGE_BYTES);
    for (const len of [
      0,
      1,
      FRAGMENT_SEND_PAYLOAD_SIZE * RECEIVER_MAX_FRAGMENTS,
      FRAGMENT_SEND_PAYLOAD_SIZE * RECEIVER_MAX_FRAGMENTS + 1,
      512 * 1024,
      MAX_REASSEMBLED_FRAME_BYTES,
    ]) {
      const parts = fragmentFrame(1, new Uint8Array(len), sizing.preferred, sizing.max);
      expect(parts.length).toBeLessThanOrEqual(RECEIVER_MAX_FRAGMENTS);
    }
  });

  test('small frames keep 16 KiB messages', () => {
    const sizing = fragmentSizing(DC_MAX_MESSAGE_BYTES);
    expect(sizing).toEqual({ preferred: FRAGMENT_SEND_PAYLOAD_SIZE, max: FRAGMENT_PAYLOAD_SIZE });
    const parts = fragmentFrame(2, new Uint8Array(64 * 1024), sizing.preferred, sizing.max);
    expect(parts[0]?.byteLength).toBe(FRAGMENT_SEND_MESSAGE_BYTES);
    expect(parts).toHaveLength(5);
  });

  test('a channel with a smaller maxMessageSize keeps its own ceiling', () => {
    const sizing = fragmentSizing(8 * 1024);
    expect(sizing).toEqual({
      preferred: 8 * 1024 - FRAGMENT_HEADER_SIZE,
      max: 8 * 1024 - FRAGMENT_HEADER_SIZE,
    });
    const parts = fragmentFrame(3, new Uint8Array(301_581), sizing.preferred, sizing.max);
    for (const part of parts) expect(part.byteLength).toBeLessThanOrEqual(8 * 1024);
  });
});
