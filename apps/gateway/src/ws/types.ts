import type { StateSnapshotPayload } from '@tmex/shared';
import type { ServerWebSocket } from 'bun';
import type { DeviceTreeOrderRecord } from '../db';
import { getDeviceTreeOrder, setPaneOrder, setWindowOrder } from '../db';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import { tmuxRuntimeRegistry } from '../tmux-client/registry';
import type { BorshClientState } from './borsh/codec-borsh';

export interface ClientState {
  borshState: BorshClientState;
}

export interface DeviceConnectionEntry {
  runtime: DeviceSessionRuntime;
  detachRuntime: (() => void) | null;
  clients: Set<ServerWebSocket<ClientState>>;
  lastSnapshot: StateSnapshotPayload | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  snapshotPollTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  canonicalClients?: Set<ServerWebSocket<ClientState>>;
  idleReleaseTimer?: ReturnType<typeof setTimeout> | null;
}

export interface WebSocketServerDeps {
  acquireRuntime: (deviceId: string) => Promise<DeviceSessionRuntime>;
  releaseRuntime: (deviceId: string, runtime: DeviceSessionRuntime) => Promise<void> | void;
  loadDeviceTreeOrder: (deviceId: string) => DeviceTreeOrderRecord;
  saveWindowOrder: (deviceId: string, windowIds: string[]) => void;
  savePaneOrder: (deviceId: string, windowId: string, paneIds: string[]) => void;
}

export const defaultDeps: WebSocketServerDeps = {
  acquireRuntime: async (deviceId) => tmuxRuntimeRegistry.acquire(deviceId),
  releaseRuntime: async (deviceId, runtime) => {
    await tmuxRuntimeRegistry.release(deviceId, runtime);
  },
  loadDeviceTreeOrder: getDeviceTreeOrder,
  saveWindowOrder: setWindowOrder,
  savePaneOrder: setPaneOrder,
};

export interface WebSocketServerOptions {
  deps?: Partial<WebSocketServerDeps>;
}

export const RUNTIME_IDLE_GRACE_MS = 5_000;
export const ENVELOPE_OVERHEAD_BYTES = 16;
