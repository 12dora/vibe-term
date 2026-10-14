import {
  type CreatePortMapRequest,
  PORT_MAP_LEASE_DEFAULT_MS,
  type PortMapDto,
  type PortMapState,
  type PortProbeResponse,
  type UpdatePortMapRequest,
} from '@vibeterm/shared';
import type { PortMapErrorCode } from '@vibeterm/shared';
import { eq } from 'drizzle-orm';
import { config } from '../config';
import { getDb } from '../db/client';
import { tlsConfig } from '../db/schema';
import { DEFAULT_TLS_PORT, TLS_CONFIG_ROW_ID } from '../tls/types';
import { solePortMapPeers } from './binding';
import { requestPeerExportRemoval } from './export-cleanup';
import { startExportLeaseSweeper } from './export-lease';
import { PortMapListener } from './listener';
import { isPortFree } from './port-probe';
import { PortMapStore, type PortMapStoreLike, defaultPortMapExportStore } from './store';
import {
  PORT_MAP_LEASE_SWEEP_MS,
  PORT_MAP_MAX_ROWS,
  type PortMapCounters,
  PortMapError,
  type PortMapPeers,
  type PortMapRow,
  assertHost,
  assertLeaseMs,
  assertMapId,
  assertName,
  assertNodeId,
  assertPort,
  createPortMapCounters,
  isLeaseExpired,
} from './types';

export type PortMapManagerDeps = {
  store: PortMapStoreLike;
  peers?: () => PortMapPeers | null;
  reservedPorts?: () => number[];
  now?: () => number;
  maxConnections?: number;
  peerStreamLimit?: number;
  /** 租约到期回收时顺手清 B 的放行行；尽力而为。 */
  removePeerExport?: (nodeId: string, mapId: string) => Promise<boolean>;
  sweepIntervalMs?: number;
};

type RowChanges = { name?: string; paused?: boolean; leaseExpiresAt?: number };

type Entry = {
  row: PortMapRow;
  counters: PortMapCounters;
  listener: PortMapListener | null;
  error: PortMapErrorCode | null;
};

function randomMapId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 本机 HTTPS 监听端口也不能被映射占用，否则下次重启时监听会失败。 */
function tlsListenPort(): number | null {
  try {
    const row = getDb()
      .select({ tlsPort: tlsConfig.tlsPort })
      .from(tlsConfig)
      .where(eq(tlsConfig.id, TLS_CONFIG_ROW_ID))
      .get();
    return row?.tlsPort ?? DEFAULT_TLS_PORT;
  } catch {
    return DEFAULT_TLS_PORT;
  }
}

function defaultReservedPorts(): number[] {
  const ports = [config.port, config.peerPort];
  const tls = tlsListenPort();
  if (tls !== null) ports.push(tls);
  return ports;
}

export class PortMapManager {
  private readonly store: PortMapStoreLike;
  private readonly peers: () => PortMapPeers | null;
  private readonly reservedPorts: () => number[];
  private readonly now: () => number;
  private readonly maxConnections: number | undefined;
  private readonly peerStreamLimit: number | undefined;
  private readonly removePeerExport: ((nodeId: string, mapId: string) => Promise<boolean>) | null;
  private readonly sweepIntervalMs: number;
  private readonly entries = new Map<string, Entry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(deps: PortMapManagerDeps) {
    this.store = deps.store;
    this.peers = deps.peers ?? solePortMapPeers;
    this.reservedPorts = deps.reservedPorts ?? defaultReservedPorts;
    this.now = deps.now ?? Date.now;
    this.maxConnections = deps.maxConnections;
    this.peerStreamLimit = deps.peerStreamLimit;
    this.removePeerExport = deps.removePeerExport ?? null;
    this.sweepIntervalMs = deps.sweepIntervalMs ?? PORT_MAP_LEASE_SWEEP_MS;
  }

  /** 开机恢复：已过期的租约行先回收、不恢复；未暂停的行逐条起监听，端口被占的保留行并标 error。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    let rows: PortMapRow[];
    try {
      rows = this.store.list();
    } catch (err) {
      console.error('[portmap] failed to load port maps', err);
      return;
    }
    const now = this.now();
    for (const row of rows) {
      if (isLeaseExpired(row, now)) {
        this.discardExpired(row);
        continue;
      }
      const entry = this.adopt(row);
      if (!row.paused) this.startEntry(entry);
    }
    this.sweepTimer = setInterval(() => this.sweepExpired(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** 回收所有已过期的租约映射（停监听、删行、尽力清 B 的放行行），返回被回收的 id。 */
  sweepExpired(): string[] {
    const now = this.now();
    const reaped: string[] = [];
    for (const entry of [...this.entries.values()]) {
      if (!isLeaseExpired(entry.row, now)) continue;
      this.stopEntry(entry);
      this.entries.delete(entry.row.id);
      this.discardExpired(entry.row);
      reaped.push(entry.row.id);
    }
    return reaped;
  }

  private discardExpired(row: PortMapRow): void {
    try {
      this.store.remove(row.id);
    } catch (err) {
      console.error('[portmap] failed to remove expired port map', err);
    }
    console.warn(`[portmap] lease expired, removed port map ${row.id} (${row.name})`);
    this.removePeerExport?.(row.targetNodeId, row.id).catch(() => undefined);
  }

  list(): PortMapDto[] {
    this.sweepExpired();
    return [...this.entries.values()]
      .map((entry) => this.toDto(entry))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PortMapDto {
    return this.toDto(this.require(id));
  }

  create(input: CreatePortMapRequest): PortMapDto {
    this.sweepExpired();
    if (this.entries.size >= PORT_MAP_MAX_ROWS) {
      throw new PortMapError('limit_reached', `at most ${PORT_MAP_MAX_ROWS} port maps`);
    }
    const row = this.buildRow(input);
    if (this.entries.has(row.id)) {
      throw new PortMapError('invalid_request', 'map id already exists');
    }
    this.checkPortAvailable(row.listenHost, row.listenPort, null);
    this.store.insert(row);
    const entry = this.adopt(row);
    this.startEntry(entry);
    if (entry.error) {
      this.store.remove(row.id);
      this.entries.delete(row.id);
      throw new PortMapError(entry.error, `failed to bind ${row.listenHost}:${row.listenPort}`);
    }
    return this.toDto(entry);
  }

  /**
   * 恢复必须「先绑上再落库」：绑定失败时行仍是 paused，端口空出来后再 PATCH 一次还能重试。
   * 只要请求的状态是未暂停且当前没有监听，就重试一次绑定——开机时端口被占的行也走这条路。
   */
  update(id: string, patch: UpdatePortMapRequest): PortMapDto {
    const entry = this.require(id);
    const changes = this.parsePatch(entry, patch);
    if (changes.paused === true) this.stopEntry(entry);
    if (changes.paused === false && !entry.listener) this.resumeEntry(entry);
    const updatedAt = this.now();
    this.store.update(id, { updatedAt, ...changes });
    entry.row = { ...entry.row, ...changes, updatedAt };
    return this.toDto(entry);
  }

  private parsePatch(entry: Entry, patch: UpdatePortMapRequest): RowChanges {
    const changes: RowChanges = {};
    if (patch.name !== undefined) changes.name = assertName(patch.name, 'name');
    if (patch.paused !== undefined) {
      if (typeof patch.paused !== 'boolean') {
        throw new PortMapError('invalid_request', 'paused must be a boolean');
      }
      changes.paused = patch.paused;
    }
    const leaseExpiresAt = this.nextLease(entry, patch);
    if (leaseExpiresAt !== undefined) changes.leaseExpiresAt = leaseExpiresAt;
    return changes;
  }

  /** `leaseMs` 显式续约（持久行也可借此加租约）；`renewLease` 只续已带租约的行，持久行保持不变。 */
  private nextLease(entry: Entry, patch: UpdatePortMapRequest): number | undefined {
    if (patch.renewLease !== undefined && typeof patch.renewLease !== 'boolean') {
      throw new PortMapError('invalid_request', 'renewLease must be a boolean');
    }
    if (patch.leaseMs !== undefined) return this.now() + assertLeaseMs(patch.leaseMs, 'leaseMs');
    if (patch.renewLease === true && entry.row.leaseExpiresAt !== undefined) {
      return this.now() + PORT_MAP_LEASE_DEFAULT_MS;
    }
    return undefined;
  }

  private resumeEntry(entry: Entry): void {
    const wasPaused = entry.row.paused;
    this.checkPortAvailable(entry.row.listenHost, entry.row.listenPort, entry.row.id);
    entry.row = { ...entry.row, paused: false };
    this.startEntry(entry);
    if (entry.listener) return;
    const code = entry.error ?? 'bind_failed';
    entry.row = { ...entry.row, paused: wasPaused };
    throw new PortMapError(code, `failed to bind ${entry.row.listenHost}:${entry.row.listenPort}`);
  }

  remove(id: string): void {
    const entry = this.require(id);
    this.stopEntry(entry);
    this.entries.delete(id);
    this.store.remove(id);
  }

  probe(host: string, port: number): PortProbeResponse {
    const listenHost = assertHost(host, 'host');
    const listenPort = assertPort(port, 'port');
    this.sweepExpired();
    const usedByMapId = this.findByPort(listenHost, listenPort, null);
    const reserved = this.reservedPorts().includes(listenPort);
    return {
      host: listenHost,
      port: listenPort,
      free: usedByMapId === null && !reserved && isPortFree(listenHost, listenPort),
      reserved,
      usedByMapId,
    };
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
    this.started = false;
  }

  private require(id: string): Entry {
    this.sweepExpired();
    const entry = this.entries.get(id);
    if (!entry) throw new PortMapError('not_found', `port map ${id} not found`);
    return entry;
  }

  private adopt(row: PortMapRow): Entry {
    const entry: Entry = { row, counters: createPortMapCounters(), listener: null, error: null };
    this.entries.set(row.id, entry);
    return entry;
  }

  private startEntry(entry: Entry): void {
    if (entry.listener || entry.row.paused) return;
    const listener = new PortMapListener({
      row: entry.row,
      peers: this.peers,
      counters: entry.counters,
      onBindFailed: () => this.markBindFailed(entry, listener),
      ...(this.maxConnections === undefined ? {} : { maxConnections: this.maxConnections }),
      ...(this.peerStreamLimit === undefined ? {} : { peerStreamLimit: this.peerStreamLimit }),
    });
    try {
      listener.start();
      entry.listener = listener;
      entry.error = null;
    } catch (err) {
      entry.listener = null;
      entry.error = err instanceof PortMapError ? err.code : 'bind_failed';
      if (!isPortFree(entry.row.listenHost, entry.row.listenPort)) entry.error = 'port_in_use';
    }
  }

  /** listen 之后才冒出来的绑定错误（同步窗口没抓到的竞态）：把行改回 error 状态。 */
  private markBindFailed(entry: Entry, listener: PortMapListener): void {
    if (entry.listener !== listener) return;
    entry.listener = null;
    entry.error = 'port_in_use';
  }

  private stopEntry(entry: Entry): void {
    entry.listener?.stop();
    entry.listener = null;
    entry.error = null;
  }

  private buildRow(input: CreatePortMapRequest): PortMapRow {
    const listenHost =
      input.listenHost === undefined ? '127.0.0.1' : assertHost(input.listenHost, 'listenHost');
    const targetHost =
      input.targetHost === undefined ? '127.0.0.1' : assertHost(input.targetHost, 'targetHost');
    const now = this.now();
    return {
      id: input.mapId === undefined ? randomMapId() : assertMapId(input.mapId, 'mapId'),
      name: input.name === undefined ? '' : assertName(input.name, 'name'),
      listenHost,
      listenPort: assertPort(input.listenPort, 'listenPort'),
      targetNodeId: assertNodeId(input.targetNodeId, 'targetNodeId'),
      targetHost,
      targetPort: assertPort(input.targetPort, 'targetPort'),
      paused: false,
      createdAt: now,
      updatedAt: now,
      ...(input.leaseMs === undefined
        ? {}
        : { leaseExpiresAt: now + assertLeaseMs(input.leaseMs, 'leaseMs') }),
    };
  }

  private findByPort(host: string, port: number, exceptId: string | null): string | null {
    for (const entry of this.entries.values()) {
      if (entry.row.id === exceptId || entry.row.paused) continue;
      if (entry.row.listenHost === host && entry.row.listenPort === port) return entry.row.id;
    }
    return null;
  }

  private checkPortAvailable(host: string, port: number, exceptId: string | null): void {
    if (this.reservedPorts().includes(port)) {
      throw new PortMapError('port_reserved', `port ${port} is used by VibeTerm itself`);
    }
    const usedBy = this.findByPort(host, port, exceptId);
    if (usedBy) {
      throw new PortMapError('port_in_use', `port ${port} is already mapped by ${usedBy}`);
    }
    if (!isPortFree(host, port)) {
      throw new PortMapError('port_in_use', `${host}:${port} is occupied`);
    }
  }

  private state(entry: Entry): PortMapState {
    if (entry.row.paused) return 'paused';
    return entry.listener ? 'listening' : 'error';
  }

  private toDto(entry: Entry): PortMapDto {
    const state = this.state(entry);
    return {
      ...entry.row,
      state,
      ...(state === 'error' ? { error: entry.error ?? 'bind_failed' } : {}),
      activeConnections: entry.counters.activeConnections,
      totalConnections: entry.counters.totalConnections,
      bytesIn: entry.counters.bytesIn,
      bytesOut: entry.counters.bytesOut,
      pendingBytes: entry.counters.pendingBytes,
    };
  }
}

let instance: PortMapManager | null = null;

/** 网关级单例：路由与 runtime 生命周期都用它，链路由 mesh 绑定后按 nodeId 解析。 */
export function portMapManager(): PortMapManager {
  instance ??= new PortMapManager({
    store: new PortMapStore(getDb()),
    removePeerExport: requestPeerExportRemoval,
  });
  return instance;
}

let stopExportSweeper: (() => void) | null = null;

export function startPortMaps(): void {
  portMapManager().start();
  stopExportSweeper ??= startExportLeaseSweeper(defaultPortMapExportStore);
}

export function stopPortMaps(): void {
  instance?.stop();
  stopExportSweeper?.();
  stopExportSweeper = null;
}
