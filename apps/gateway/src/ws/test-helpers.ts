import type { StateSnapshotPayload } from '@tmex/shared';
import { wsBorsh } from '@tmex/shared';
import { createBorshClientState } from './borsh/codec-borsh';
import { sessionStateStore } from './borsh/session-state';
import type { DeviceConnectionEntry } from './types';

export interface BorshTestWs {
  data: { borshState: ReturnType<typeof createBorshClientState> };
  sent: Uint8Array[];
  send(message: Uint8Array): number | undefined;
  terminate(): void;
}

export interface CreateBorshTestWsOptions {
  session?: boolean;
  send?: (this: BorshTestWs, message: Uint8Array) => number | undefined;
  terminate?: (this: BorshTestWs) => void;
}

export function createBorshTestWs(options: CreateBorshTestWsOptions = {}): BorshTestWs {
  const ws: BorshTestWs = {
    data: { borshState: createBorshClientState() },
    sent: [],
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
  };
  if (options.session) {
    sessionStateStore.create(ws as never);
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
