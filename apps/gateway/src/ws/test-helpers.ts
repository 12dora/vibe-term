import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import type { ClientState, DeviceConnectionEntry } from './types';

export type BorshTestWs = ServerWebSocket<ClientState> & { sent: Uint8Array[] };

export interface CreateBorshTestWsOptions {
  session?: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: send() {} fixtures must typecheck without a dummy return
  send?: (message: Uint8Array) => number | undefined | void;
  terminate?: (this: BorshTestWs) => void;
}

export function createBorshTestWs(options: CreateBorshTestWsOptions = {}): BorshTestWs {
  const ws = {
    data: { borshState: createBorshClientState() },
    sent: [] as Uint8Array[],
    send(message: Uint8Array) {
      if (options.send) {
        return options.send.call(this, message);
      }
      this.sent.push(message);
      return message.byteLength;
    },
    terminate() {
      options.terminate?.call(this);
    },
  } as BorshTestWs;
  if (options.session) {
    sessionStateStore.create(ws);
  }
  return ws;
}

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

export function envelopeKind(bytes: Uint8Array): number | null {
  if (!wsBorsh.checkMagic(bytes)) return null;
  try {
    return wsBorsh.decodeEnvelope(bytes).kind;
  } catch {
    return null;
  }
}
