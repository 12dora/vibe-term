import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import {
  type BorshDispatchHost,
  createBorshKindHandlers,
  dispatchBorshKind,
} from './borsh-dispatcher';
import { createBorshClientState } from './borsh/codec-borsh';
import { WebSocketServer } from './index';
import { type ClientState, asSwitchBarrierSocket } from './types';

function createWs(): ServerWebSocket<ClientState> & { sent: Uint8Array[] } {
  const sent: Uint8Array[] = [];
  return {
    data: { borshState: createBorshClientState() },
    sent,
    send(message: Uint8Array) {
      sent.push(message);
      return message.byteLength;
    },
  } as ServerWebSocket<ClientState> & { sent: Uint8Array[] };
}

describe('WebSocketServer host interfaces', () => {
  test('implements BorshDispatchHost without a cast at the dispatcher boundary', async () => {
    const server = new WebSocketServer();
    const handlers = createBorshKindHandlers(server);
    const host: Pick<BorshDispatchHost, 'sendError'> = server;
    const ws = createWs();

    await dispatchBorshKind(handlers, host, ws, 0xdead, 9, new Uint8Array());

    expect(ws.sent.length).toBe(1);
    const envelope = wsBorsh.decodeEnvelope(ws.sent[0]);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
  });

  test('asSwitchBarrierSocket keeps the same socket instance', () => {
    const ws = createWs();
    expect(asSwitchBarrierSocket(ws)).toBe(ws);
  });
});
