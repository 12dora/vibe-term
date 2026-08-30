import { describe, expect, spyOn, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import { WebSocketServer } from './index';
import { createBorshTestWs, createFakeCarrier } from './test-helpers';

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function encodeHelloFrame() {
  const payload = wsBorsh.encodePayload(wsBorsh.schema.HelloC2SSchema, {
    clientImpl: 'inbound-frame-test',
    clientVersion: '0.0.1',
    maxFrameBytes: 65_536,
    supportsCompression: false,
    supportsDiffSnapshot: false,
  });
  return {
    payload,
    frame: wsBorsh.encodeEnvelope(wsBorsh.KIND_HELLO_C2S, payload, 1),
  };
}

describe('WebSocket inbound binary frames', () => {
  test('handlers receive identical payload bytes from an inbound Buffer', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const inbound = Buffer.from(frame);
    expect(inbound).toBeInstanceOf(Uint8Array);

    server.handleOpen(ws);
    server.handleMessage(ws, inbound);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
    server.handleClose(ws);
  });

  test('handlers receive identical bytes from a Buffer view over a larger backing store', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const backing = Buffer.alloc(frame.byteLength + 6, 0xff);
    backing.set(frame, 3);
    const inbound = backing.subarray(3, 3 + frame.byteLength);

    server.handleOpen(ws);
    server.handleMessage(ws, inbound);
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
    server.handleClose(ws);
  });

  test('mesh decoded envelope is not envelope-decoded again', async () => {
    const server = new WebSocketServer();
    const attached = server.attachStreamSession(createFakeCarrier());
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );
    const { frame, payload } = encodeHelloFrame();
    const envelope = wsBorsh.decodeEnvelope(frame);
    const decode = spyOn(wsBorsh, 'decodeEnvelope');
    attached.onDecodedEnvelope(envelope);
    await flushAsync();
    const extraDecodes = decode.mock.calls.length;
    decode.mockRestore();
    handleBorshMessage.mockRestore();
    attached.onClose();
    expect(extraDecodes).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  test('async-retaining handler still sees stable bytes after inbound buffer reuse', async () => {
    const server = new WebSocketServer();
    const attached = server.attachStreamSession(createFakeCarrier());
    const received: Uint8Array[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        await blocked;
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const backing = new Uint8Array(frame.byteLength);
    backing.set(frame);
    attached.onDecodedEnvelope(wsBorsh.decodeEnvelopeView(backing));
    backing.fill(0xee);
    release();
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
    attached.onClose();
  });
});

function decodeErrorFrame(frame: Uint8Array) {
  const envelope = wsBorsh.decodeEnvelope(frame);
  expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
  return wsBorsh.decodePayload(wsBorsh.schema.ErrorSchema, envelope.payload);
}

describe('RTC inbound decoded envelope', () => {
  test('frame is envelope-decoded exactly once and skips handleMessage', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        received.push(payload);
      }
    );
    const handleMessage = spyOn(server, 'handleMessage');
    const decode = spyOn(wsBorsh, 'decodeEnvelope');
    const { frame, payload } = encodeHelloFrame();

    server.deliverRtcInbound(ws, frame);
    await flushAsync();

    expect(decode.mock.calls.length).toBe(1);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    decode.mockRestore();
    handleMessage.mockRestore();
    handleBorshMessage.mockRestore();
  });

  test('invalid RTC envelope matches handleMessage error frames', () => {
    const cases: Uint8Array[] = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array(20),
      (() => {
        const withMagic = new Uint8Array(20);
        withMagic[0] = 0x54;
        withMagic[1] = 0x58;
        return withMagic;
      })(),
    ];
    for (const bytes of cases) {
      const viaMessage = new WebSocketServer();
      const wsMessage = createBorshTestWs();
      viaMessage.handleMessage(wsMessage, Buffer.from(bytes));

      const viaRtc = new WebSocketServer();
      const wsRtc = createBorshTestWs();
      viaRtc.deliverRtcInbound(wsRtc, bytes);

      expect(wsRtc.sent).toHaveLength(wsMessage.sent.length);
      const rtcFrame = wsRtc.sent[0];
      const messageFrame = wsMessage.sent[0];
      if (!rtcFrame || !messageFrame) continue;
      expect(decodeErrorFrame(rtcFrame)).toEqual(decodeErrorFrame(messageFrame));
    }
  });

  test('async-retaining handler sees stable bytes after RTC buffer reuse', async () => {
    const server = new WebSocketServer();
    const ws = createBorshTestWs();
    const received: Uint8Array[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handleBorshMessage = spyOn(server, 'handleBorshMessage').mockImplementation(
      async (_ws, _kind, _seq, payload) => {
        await blocked;
        received.push(payload);
      }
    );

    const { frame, payload } = encodeHelloFrame();
    const backing = new Uint8Array(frame.byteLength);
    backing.set(frame);
    const decode = spyOn(wsBorsh, 'decodeEnvelope').mockImplementation((data) =>
      wsBorsh.decodeEnvelopeView(data)
    );
    server.deliverRtcInbound(ws, backing);
    backing.fill(0xee);
    decode.mockRestore();
    release();
    await flushAsync();

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);

    handleBorshMessage.mockRestore();
  });
});
