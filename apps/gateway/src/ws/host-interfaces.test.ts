import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  type BorshDispatchHost,
  createBorshKindHandlers,
  dispatchBorshKind,
} from './borsh-dispatcher';
import { WebSocketServer } from './index';
import { createGatewaySession } from './test-helpers';

describe('WebSocketServer host interfaces', () => {
  test('implements BorshDispatchHost without a cast at the dispatcher boundary', async () => {
    const server = new WebSocketServer();
    const handlers = createBorshKindHandlers(server);
    const host: Pick<BorshDispatchHost, 'sendError'> = server;
    const session = createGatewaySession();

    await dispatchBorshKind(handlers, host, session, 0xdead, 9, new Uint8Array());

    expect(session.sent.length).toBe(1);
    const envelope = wsBorsh.decodeEnvelope(session.sent[0]);
    expect(envelope.kind).toBe(wsBorsh.KIND_ERROR);
  });

  test('GatewaySession identity is preserved across host callbacks', () => {
    const session = createGatewaySession();
    expect(session.data.session).toBe(session);
    expect(session.activeCarrier).toBe(session.primary);
  });
});
