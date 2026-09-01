import type { EventDevicePayload, ThemeMode } from '@tmex/shared';
import { getTmuxWindowStyle, wsBorsh } from '@tmex/shared';
import { getSiteSettings } from '../db';
import { t } from '../i18n';
import type { DeviceSessionRuntime } from '../tmux-client/device-session-runtime';
import type { CanonicalFeedSession } from './canonical-feed-session';
import { classifySshError } from './error-classify';
import type { GatewaySession } from './gateway-session';
import {
  type DeviceConnectionEntry,
  RUNTIME_IDLE_GRACE_MS,
  type WebSocketServerDeps,
} from './types';

export interface DeviceConnectionRegistryHost {
  readonly deps: WebSocketServerDeps;
  readonly currentTheme: ThemeMode | null;
  readonly canonicalSessions: Map<GatewaySession, CanonicalFeedSession>;
  createDeviceConnectionEntry(
    deviceId: string,
    session: GatewaySession
  ): Promise<DeviceConnectionEntry | null>;
  attachRuntime(deviceId: string, runtime: DeviceSessionRuntime): () => void;
  releaseConnectionEntry(deviceId: string, entry: DeviceConnectionEntry): void;
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
  sendChunked(session: GatewaySession, kind: number, payload: Uint8Array): boolean;
  encodeSnapshotWithOverlays(
    payload: NonNullable<DeviceConnectionEntry['lastSnapshot']>
  ): Uint8Array;
  broadcastDeviceEvent(entry: DeviceConnectionEntry, payload: EventDevicePayload): void;
  releaseLegacyPaneObservers(session: GatewaySession, deviceId?: string): void;
  syncLegacyPaneObservers(session: GatewaySession, deviceId: string): void;
  dropViewportClaims(
    session: GatewaySession,
    deviceId?: string,
    options?: { recompute?: boolean }
  ): void;
}

export class DeviceConnectionRegistry {
  connections = new Map<string, DeviceConnectionEntry>();
  pendingConnectionEntries = new Map<string, Promise<DeviceConnectionEntry | null>>();
  private closed = false;
  private generation = 0;
  private readonly connectGenerations = new WeakMap<GatewaySession, Map<string, number>>();

  constructor(private readonly host: DeviceConnectionRegistryHost) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get closeGeneration(): number {
    return this.generation;
  }

  clearSnapshotTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotTimer) return;
    clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = null;
  }

  clearSnapshotPollTimer(entry: DeviceConnectionEntry): void {
    if (!entry.snapshotPollTimer) return;
    clearInterval(entry.snapshotPollTimer);
    entry.snapshotPollTimer = null;
  }

  clearReconnectTimer(entry: DeviceConnectionEntry): void {
    if (!entry.reconnectTimer) return;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  clearIdleReleaseTimer(entry: DeviceConnectionEntry): void {
    if (!entry.idleReleaseTimer) return;
    clearTimeout(entry.idleReleaseTimer);
    entry.idleReleaseTimer = null;
  }

  entryHasClients(entry: DeviceConnectionEntry): boolean {
    return entry.clients.size > 0 || Boolean(entry.canonicalClients?.size);
  }

  scheduleConnectionEntryRelease(deviceId: string, entry: DeviceConnectionEntry): void {
    if (this.entryHasClients(entry)) {
      this.clearIdleReleaseTimer(entry);
      return;
    }
    if (entry.idleReleaseTimer) return;
    entry.idleReleaseTimer = setTimeout(() => {
      entry.idleReleaseTimer = null;
      if (this.connections.get(deviceId) !== entry || this.entryHasClients(entry)) return;
      this.connections.delete(deviceId);
      this.host.releaseConnectionEntry(deviceId, entry);
    }, RUNTIME_IDLE_GRACE_MS);
  }

  async getOrCreate(
    deviceId: string,
    session: GatewaySession
  ): Promise<DeviceConnectionEntry | null> {
    if (this.closed) return null;

    const existing = this.connections.get(deviceId);
    if (existing) {
      this.clearIdleReleaseTimer(existing);
      return existing;
    }

    const pending = this.pendingConnectionEntries.get(deviceId);
    if (pending) {
      return pending;
    }

    const generation = this.generation;
    const creationPromise: Promise<DeviceConnectionEntry | null> = this.host
      .createDeviceConnectionEntry(deviceId, session)
      .then((createdEntry) => {
        if (this.closed || this.generation !== generation) {
          if (createdEntry) {
            this.host.releaseConnectionEntry(deviceId, createdEntry);
          }
          return null;
        }
        if (createdEntry) {
          this.connections.set(deviceId, createdEntry);
        }
        return createdEntry;
      })
      .finally(() => {
        if (this.pendingConnectionEntries.get(deviceId) === creationPromise) {
          this.pendingConnectionEntries.delete(deviceId);
        }
      });

    this.pendingConnectionEntries.set(deviceId, creationPromise);
    return creationPromise;
  }

  closeAll(): void {
    this.closed = true;
    this.generation += 1;
    for (const [deviceId, entry] of this.connections) {
      this.host.releaseConnectionEntry(deviceId, entry);
      this.connections.delete(deviceId);
    }
    this.pendingConnectionEntries.clear();
  }

  async createEntry(
    deviceId: string,
    session: GatewaySession
  ): Promise<DeviceConnectionEntry | null> {
    let runtime: DeviceSessionRuntime | null = null;
    let detachRuntime: (() => void) | null = null;

    try {
      runtime = await this.host.deps.acquireRuntime(deviceId);
      detachRuntime = this.host.attachRuntime(deviceId, runtime);

      await runtime.connect();
      if (this.host.currentTheme !== null) {
        await runtime.setWindowStyle(getTmuxWindowStyle(this.host.currentTheme));
      }
      return {
        runtime,
        detachRuntime,
        clients: new Set(),
        lastSnapshot: runtime.getCurrentSnapshot?.() ?? null,
        snapshotTimer: null,
        snapshotPollTimer: null,
        reconnectAttempts: 0,
        reconnectTimer: null,
        canonicalClients: new Set(),
        idleReleaseTimer: null,
      };
    } catch (err) {
      detachRuntime?.();
      if (runtime) {
        void this.host.deps.releaseRuntime(deviceId, runtime);
      }
      const errorInfo = classifySshError(err instanceof Error ? err : new Error(String(err)));
      this.host.sendEnvelope(
        session,
        wsBorsh.KIND_DEVICE_EVENT,
        wsBorsh.encodeDeviceEventPayload({
          deviceId,
          type: 'error',
          errorType: errorInfo.type,
          message: t(errorInfo.messageKey, { ...errorInfo.messageParams }),
          rawMessage: err instanceof Error ? err.message : String(err),
        })
      );
      return null;
    }
  }

  private bumpConnectGeneration(session: GatewaySession, deviceId: string): number {
    let gens = this.connectGenerations.get(session);
    if (!gens) {
      gens = new Map();
      this.connectGenerations.set(session, gens);
    }
    const next = (gens.get(deviceId) ?? 0) + 1;
    gens.set(deviceId, next);
    return next;
  }

  private connectGenerationOf(session: GatewaySession, deviceId: string): number {
    return this.connectGenerations.get(session)?.get(deviceId) ?? 0;
  }

  abandonSocket(session: GatewaySession): void {
    this.connectGenerations.delete(session);
  }

  async handleDeviceConnect(session: GatewaySession, deviceId: string): Promise<void> {
    const connectGen = this.bumpConnectGeneration(session, deviceId);
    const entry = await this.getOrCreate(deviceId, session);
    if (this.connectGenerationOf(session, deviceId) !== connectGen) {
      if (entry) this.scheduleConnectionEntryRelease(deviceId, entry);
      return;
    }
    if (!entry) return;

    entry.clients.add(session);
    this.clearIdleReleaseTimer(entry);
    session.borshState.selectedPanes[deviceId] ??= null;
    this.host.syncLegacyPaneObservers(session, deviceId);

    const canonicalSession = this.host.canonicalSessions.get(session);
    if (canonicalSession) await canonicalSession.attachDevice(deviceId, entry.runtime);

    const connectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceConnectedSchema, {
      deviceId,
    });
    this.host.sendEnvelope(session, wsBorsh.KIND_DEVICE_CONNECTED, connectedPayload);

    if (entry.lastSnapshot) {
      if (!entry.canonicalClients?.has(session)) {
        const snapshotBytes = this.host.encodeSnapshotWithOverlays(entry.lastSnapshot);
        this.host.sendChunked(session, wsBorsh.KIND_STATE_SNAPSHOT, snapshotBytes);
      }
    } else {
      entry.runtime.requestSnapshot();
    }
  }

  handleDeviceDisconnect(session: GatewaySession, deviceId: string): void {
    this.bumpConnectGeneration(session, deviceId);
    this.host.canonicalSessions.get(session)?.detachDevice(deviceId);
    this.host.releaseLegacyPaneObservers?.(session, deviceId);
    const entry = this.connections.get(deviceId);
    if (entry) {
      entry.clients.delete(session);
      this.clearSnapshotPollTimer(entry);
      this.scheduleConnectionEntryRelease(deviceId, entry);
    }

    delete session.borshState.selectedPanes[deviceId];
    delete session.borshState.subscribedPanes[deviceId];
    this.host.dropViewportClaims?.(session, deviceId);

    const disconnectedPayload = wsBorsh.encodePayload(wsBorsh.schema.DeviceDisconnectedSchema, {
      deviceId,
    });
    this.host.sendEnvelope(session, wsBorsh.KIND_DEVICE_DISCONNECTED, disconnectedPayload);
  }

  async handleConnectionClose(deviceId: string): Promise<void> {
    const entry = this.connections.get(deviceId);
    if (!entry) {
      return;
    }

    this.clearSnapshotTimer(entry);
    this.clearSnapshotPollTimer(entry);
    entry.detachRuntime?.();
    entry.detachRuntime = null;
    const closedRuntime = entry.runtime;
    void this.host.deps.releaseRuntime(deviceId, closedRuntime);

    const { sshReconnectMaxRetries, sshReconnectDelaySeconds } = getSiteSettings();

    if (this.entryHasClients(entry) && entry.reconnectAttempts < sshReconnectMaxRetries) {
      entry.reconnectAttempts += 1;
      const delay = Math.max(1, sshReconnectDelaySeconds) * 1000;

      const notifying: EventDevicePayload = {
        deviceId,
        type: 'error',
        errorType: 'reconnecting',
        message: t('sshError.reconnecting', {
          delay: delay / 1000,
          attempt: entry.reconnectAttempts,
          maxRetries: sshReconnectMaxRetries,
        }),
      };
      this.host.broadcastDeviceEvent(entry, notifying);

      this.clearReconnectTimer(entry);
      entry.reconnectTimer = setTimeout(async () => {
        entry.reconnectTimer = null;

        const current = this.connections.get(deviceId);
        if (this.closed || !current || current !== entry || !this.entryHasClients(entry)) {
          return;
        }

        const retryClient =
          Array.from(entry.clients)[0] ?? Array.from(entry.canonicalClients ?? [])[0];
        if (!retryClient) return;
        const retryConnection = await this.host.createDeviceConnectionEntry(deviceId, retryClient);
        if (this.closed) {
          if (retryConnection) {
            this.host.releaseConnectionEntry(deviceId, retryConnection);
          }
          return;
        }
        if (!retryConnection) {
          if (entry.reconnectAttempts < sshReconnectMaxRetries) {
            await this.handleConnectionClose(deviceId);
            return;
          }

          this.finalizeReconnectFailure(deviceId, entry, {
            deviceId,
            type: 'error',
            errorType: 'reconnect_failed',
            message: t('sshError.reconnectFailed'),
          });
          return;
        }

        retryConnection.clients = entry.clients;
        retryConnection.canonicalClients = entry.canonicalClients ?? new Set();
        retryConnection.reconnectAttempts = entry.reconnectAttempts;
        this.connections.set(deviceId, retryConnection);

        for (const client of retryConnection.canonicalClients) {
          await this.host.canonicalSessions
            .get(client)
            ?.attachDevice(deviceId, retryConnection.runtime);
        }

        const reconnected: EventDevicePayload = {
          deviceId,
          type: 'reconnected',
          message: t('sshError.reconnected'),
        };
        this.host.broadcastDeviceEvent(retryConnection, reconnected);

        retryConnection.runtime.requestSnapshot();
      }, delay);

      return;
    }

    this.finalizeReconnectFailure(deviceId, entry, {
      deviceId,
      type: 'disconnected',
    });
  }

  finalizeReconnectFailure(
    deviceId: string,
    entry: DeviceConnectionEntry,
    event: EventDevicePayload
  ): void {
    this.host.broadcastDeviceEvent(entry, event);
    this.clearReconnectTimer(entry);
    for (const client of entry.canonicalClients ?? []) {
      this.host.canonicalSessions.get(client)?.detachDevice(deviceId);
    }
    for (const client of entry.clients) {
      this.host.releaseLegacyPaneObservers?.(client, deviceId);
      delete client.borshState.selectedPanes[deviceId];
      this.host.dropViewportClaims?.(client, deviceId, { recompute: false });
    }
    entry.clients.clear();
    entry.canonicalClients?.clear();
    this.connections.delete(deviceId);
  }
}
