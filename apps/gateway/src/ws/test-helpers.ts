import type { StateSnapshotPayload } from '@tmex/shared';
import { sessionStateStore } from './borsh/session-state';
import type { Carrier, CarrierSendResult } from './carrier';
import { GatewaySession } from './gateway-session';
import type { DeviceConnectionEntry } from './types';

export interface FakeCarrier extends Carrier {
  sent: Uint8Array[];
  closeCalls: Array<{ code: number; reason: string }>;
}

export interface CreateFakeCarrierOptions {
  // biome-ignore lint/suspicious/noConfusingVoidType: send() {} fixtures must typecheck without a dummy return
  send?: (this: FakeCarrier, message: Uint8Array) => CarrierSendResult | number | undefined | void;
  terminate?: (this: FakeCarrier) => void;
  bufferedAmount?: number;
}

function mapNumericSend(status: number): CarrierSendResult {
  if (status > 0) return 'sent';
  if (status === -1) return 'backpressure';
  return 'closed';
}

export function createFakeCarrier(options: CreateFakeCarrierOptions = {}): FakeCarrier {
  const drainCallbacks: Array<() => void> = [];
  const carrier: FakeCarrier = {
    sent: [],
    closeCalls: [],
    send(bytes) {
      if (options.send) {
        const result = options.send.call(carrier, bytes);
        if (typeof result === 'number') return mapNumericSend(result);
        if (result === undefined) return 'sent';
        return result;
      }
      carrier.sent.push(bytes);
      return 'sent';
    },
    bufferedAmount() {
      return options.bufferedAmount ?? 0;
    },
    onDrain(cb) {
      drainCallbacks.push(cb);
    },
    close(code, reason) {
      carrier.closeCalls.push({ code, reason });
    },
    terminate() {
      options.terminate?.call(carrier);
    },
  };
  return carrier;
}

export interface CreateGatewaySessionOptions {
  id?: string;
  session?: boolean;
  send?: CreateFakeCarrierOptions['send'];
  terminate?: CreateFakeCarrierOptions['terminate'];
  carrier?: Carrier;
}

export type BorshTestWs = GatewaySession & {
  sent: Uint8Array[];
  data: {
    borshState: GatewaySession['borshState'];
    session: GatewaySession;
    carrier: Carrier;
  };
  // biome-ignore lint/suspicious/noConfusingVoidType: send() {} fixtures must typecheck without a dummy return
  send: (message: Uint8Array) => number | undefined | void;
  terminate: () => void;
};

export function createGatewaySession(options: CreateGatewaySessionOptions = {}): BorshTestWs {
  const carrier = (options.carrier as FakeCarrier | undefined) ?? createFakeCarrier(options);
  const session = new GatewaySession({ id: options.id, primary: carrier });
  const data = {
    borshState: session.borshState,
    session,
    carrier,
  };
  Object.defineProperty(data, 'borshState', {
    get: () => session.borshState,
    set: (value: GatewaySession['borshState']) => {
      session.borshState = value;
    },
    enumerable: true,
    configurable: true,
  });
  const testSession = session as BorshTestWs;
  Object.defineProperty(testSession, 'sent', {
    get: () => ('sent' in carrier ? carrier.sent : []),
  });
  Object.defineProperty(testSession, 'data', {
    value: data,
    writable: true,
  });
  testSession.send = (message) => {
    const result = carrier.send(message);
    if (result === 'sent') return message.byteLength;
    if (result === 'backpressure') return -1;
    return 0;
  };
  testSession.terminate = () => carrier.terminate();
  if (options.session) {
    sessionStateStore.create(session);
  }
  return testSession;
}

export const createBorshTestWs = createGatewaySession;

export interface SetupConnectionEntryOptions {
  deviceId?: string;
  ws?: unknown;
  clients?: Set<unknown>;
  runtime?: unknown;
  lastSnapshot?: StateSnapshotPayload | null;
}

export function setupConnectionEntry(
  server: { connections: Map<string, DeviceConnectionEntry> },
  options: SetupConnectionEntryOptions = {}
): DeviceConnectionEntry {
  const deviceId = options.deviceId ?? 'device-a';
  const entry = {
    runtime: (options.runtime ?? {}) as DeviceConnectionEntry['runtime'],
    detachRuntime: () => {},
    clients: (options.clients ??
      new Set(options.ws ? [options.ws] : [])) as DeviceConnectionEntry['clients'],
    lastSnapshot: options.lastSnapshot ?? null,
    snapshotTimer: null,
    snapshotPollTimer: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
  } satisfies DeviceConnectionEntry;
  server.connections.set(deviceId, entry);
  return entry;
}
