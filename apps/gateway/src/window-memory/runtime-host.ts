import type { StateSnapshotPayload } from '@vibeterm/shared';
import type { WindowMemoryAggregate } from './types';

export type WindowMemoryRuntimeView = {
  getWindowMemory?(): WindowMemoryAggregate[];
  getWindowMemorySupported?(): boolean | null;
  getWindowMemoryLimitsSupported?(): boolean | null;
  getCurrentSnapshot?(): StateSnapshotPayload | null;
  onWindowMemory?(listener: (windows: WindowMemoryAggregate[]) => void): () => void;
  tickWindowMemory?(): Promise<void> | void;
  isConnected?(): boolean;
};

export type WindowMemoryRuntimeHost = {
  getRuntime(deviceId: string): WindowMemoryRuntimeView | undefined;
  requestTickAll(): void;
};

let host: WindowMemoryRuntimeHost | null = null;

export function bindWindowMemoryRuntimeHost(next: WindowMemoryRuntimeHost | null): void {
  host = next;
}

export function requestWindowMemoryTickAll(): void {
  host?.requestTickAll();
}

export function getWindowMemoryRuntime(deviceId: string): WindowMemoryRuntimeView | undefined {
  return host?.getRuntime(deviceId);
}
