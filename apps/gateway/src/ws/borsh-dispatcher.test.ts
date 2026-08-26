import { describe, expect, test } from 'bun:test';
import { wsBorsh } from '@tmex/shared';
import {
  type BorshDispatchHost,
  createBorshKindHandlers,
  decodeBorshKindPayload,
  dispatchBorshKind,
} from './borsh-dispatcher';
import { createBorshClientState } from './borsh/codec-borsh';

function createWs() {
  return {
    data: { borshState: createBorshClientState() },
    sent: [] as Uint8Array[],
    send(message: Uint8Array) {
      this.sent.push(message);
    },
  } as any;
}

describe('borsh dispatcher', () => {
  test('unknown kind sends ERROR_UNKNOWN_KIND without invoking handlers', async () => {
    const errors: Array<{ code: number; message: string; refSeq: number | null }> = [];
    const host = {
      sendError(_ws, refSeq, code, message) {
        errors.push({ code, message, refSeq });
      },
    } as Pick<BorshDispatchHost, 'sendError'>;
    const ws = createWs();
    const handlers = createBorshKindHandlers({} as BorshDispatchHost);

    await dispatchBorshKind(handlers, host, ws, 0xdead, 9, new Uint8Array());

    expect(errors).toEqual([
      { code: wsBorsh.ERROR_UNKNOWN_KIND, message: 'Unknown kind: 57005', refSeq: 9 },
    ]);
  });

  test('schema handler decodes payload then invokes the mapped method', async () => {
    const calls: string[] = [];
    const host = {
      handleDeviceDisconnect(_ws: unknown, deviceId: string) {
        calls.push(deviceId);
      },
      sendError() {
        throw new Error('sendError should not be called');
      },
    } as unknown as BorshDispatchHost;
    const handlers = createBorshKindHandlers(host);
    const handler = handlers.get(wsBorsh.KIND_DEVICE_DISCONNECT);
    expect(handler?.schema).toBeDefined();

    const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectSchema, {
      deviceId: 'dev-1',
    });
    await dispatchBorshKind(handlers, host, createWs(), wsBorsh.KIND_DEVICE_DISCONNECT, 1, payload);

    expect(calls).toEqual(['dev-1']);
  });

  test('malformed schema payload throws WsBorshError before handle', async () => {
    let handled = false;
    const host = {
      handleDeviceConnect() {
        handled = true;
      },
      sendError() {
        throw new Error('dispatcher should not convert decode errors itself');
      },
    } as unknown as BorshDispatchHost;
    const handlers = createBorshKindHandlers(host);
    const handler = handlers.get(wsBorsh.KIND_DEVICE_CONNECT);
    if (!handler) throw new Error('missing device connect handler');

    expect(() => decodeBorshKindPayload(handler, new Uint8Array([0xff]))).toThrow(
      wsBorsh.WsBorshError
    );
    await expect(
      dispatchBorshKind(
        handlers,
        host,
        createWs(),
        wsBorsh.KIND_DEVICE_CONNECT,
        3,
        new Uint8Array([0xff])
      )
    ).rejects.toBeInstanceOf(wsBorsh.WsBorshError);
    expect(handled).toBe(false);
  });

  test('handler runtime errors propagate instead of being converted to decode errors', async () => {
    const host = {
      handleDeviceDisconnect() {
        throw new Error('boom');
      },
      sendError() {
        throw new Error('sendError should not be called');
      },
    } as unknown as BorshDispatchHost;
    const handlers = createBorshKindHandlers(host);
    const payload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectSchema, {
      deviceId: 'dev-1',
    });

    await expect(
      dispatchBorshKind(handlers, host, createWs(), wsBorsh.KIND_DEVICE_DISCONNECT, 4, payload)
    ).rejects.toThrow('boom');
  });
});
