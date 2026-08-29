import { wsBorsh } from '@tmex/shared';

export type InboundFrameResult =
  | { status: 'ignore' }
  | { status: 'error'; code: number; message: string; retryable: boolean }
  | { status: 'ok'; kind: number; seq: number; payload: Uint8Array };

function protocolError(
  err: unknown,
  fallbackMessage: string
): Extract<InboundFrameResult, { status: 'error' }> {
  const e = err instanceof wsBorsh.WsBorshError ? err : null;
  return {
    status: 'error',
    code: e?.code ?? wsBorsh.ERROR_INVALID_FRAME,
    message: e?.message ?? fallbackMessage,
    retryable: e?.retryable ?? false,
  };
}

export function decodeInboundFrame(
  data: Uint8Array,
  reassembler: wsBorsh.ChunkReassembler
): InboundFrameResult {
  if (!wsBorsh.checkMagic(data)) {
    return {
      status: 'error',
      code: wsBorsh.ERROR_INVALID_FRAME,
      message: 'Missing magic bytes',
      retryable: false,
    };
  }

  let envelope: wsBorsh.Envelope;
  try {
    envelope = wsBorsh.decodeEnvelope(data);
  } catch (err) {
    return protocolError(err, 'Invalid envelope');
  }

  if (envelope.kind !== wsBorsh.KIND_CHUNK) {
    return {
      status: 'ok',
      kind: envelope.kind,
      seq: envelope.seq,
      payload: envelope.payload,
    };
  }

  try {
    const chunk = wsBorsh.decodeChunk(envelope.payload);
    const reassembled = reassembler.addChunk(chunk);
    if (!reassembled) {
      return { status: 'ignore' };
    }
    return {
      status: 'ok',
      kind: reassembled.kind,
      seq: reassembled.seq,
      payload: reassembled.payload,
    };
  } catch (err) {
    return protocolError(err, 'Invalid chunk');
  }
}
