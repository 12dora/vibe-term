import type {
  CreatePortMapRequest,
  PortMapDto,
  PortMapState,
  PortProbeResponse,
  UpdatePortMapRequest,
} from '@tmex/shared';
import type { PortMapErrorCode } from '@tmex/shared';
import { config } from '../config';
import { getDb } from '../db/client';
import { solePortMapPeers } from './binding';
import { PortMapListener } from './listener';
import { isPortFree } from './port-probe';
import { PortMapStore, type PortMapStoreLike } from './store';
import {
  PORT_MAP_MAX_ROWS,
  type PortMapCounters,
  PortMapError,
  type PortMapPeers,
  type PortMapRow,
  assertHost,
  assertMapId,
  assertName,
  assertNodeId,
  assertPort,
  createPortMapCounters,
} from './types';

export type PortMapManagerDeps = {
  store: PortMapStoreLike;
  peers?: () => PortMapPeers | null;
  reservedPorts?: () => number[];
  now?: () => number;
  maxConnections?: number;
};

type Entry = {
  row: PortMapRow;
  counters: PortMapCounters;
  listener: PortMapListener | null;
  error: PortMapErrorCode | null;
};

function randomMapId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function defaultReservedPorts(): number[] {
  return [config.port, config.peerPort];
}

export class PortMapManager {
  private readonly store: PortMapStoreLike;
  private readonly peers: () => PortMapPeers | null;
  private readonly reservedPorts: () => number[];
  private readonly now: () => number;
  private readonly maxConnections: number | undefined;
  private readonly entries = new Map<string, Entry>();
  private started = false;

  constructor(deps: PortMapManagerDeps) {
    this.store = deps.store;
    this.peers = deps.peers ?? solePortMapPeers;
    this.reservedPorts = deps.reservedPorts ?? defaultReservedPorts;
    this.now = deps.now ?? Date.now;
    this.maxConnections = deps.maxConnections;
  }

  /** 开机恢复：未暂停的行逐条起监听，端口被占的保留行并标 error。 */
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
    for (const row of rows) {
      const entry = this.adopt(row);
      if (!row.paused) this.startEntry(entry);
    }
  }

  list(): PortMapDto[] {
    return [...this.entries.values()]
      .map((entry) => this.toDto(entry))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): PortMapDto {
    return this.toDto(this.require(id));
  }

  create(input: CreatePortMapRequest): PortMapDto {
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

  update(id: string, patch: UpdatePortMapRequest): PortMapDto {
    const entry = this.require(id);
    const name = patch.name === undefined ? undefined : assertName(patch.name, 'name');
    const paused = patch.paused;
    if (paused !== undefined && typeof paused !== 'boolean') {
      throw new PortMapError('invalid_request', 'paused must be a boolean');
    }
    const wasPaused = entry.row.paused;
    const updatedAt = this.now();
    this.store.update(id, {
      updatedAt,
      ...(name === undefined ? {} : { name }),
      ...(paused === undefined ? {} : { paused }),
    });
    entry.row = {
      ...entry.row,
      ...(name === undefined ? {} : { name }),
      ...(paused === undefined ? {} : { paused }),
      updatedAt,
    };
    if (paused === true) this.stopEntry(entry);
    if (paused === false && wasPaused) {
      this.checkPortAvailable(entry.row.listenHost, entry.row.listenPort, entry.row.id);
      this.startEntry(entry);
    }
    return this.toDto(entry);
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
    for (const entry of this.entries.values()) this.stopEntry(entry);
    this.entries.clear();
    this.started = false;
  }

  private require(id: string): Entry {
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
      ...(this.maxConnections === undefined ? {} : { maxConnections: this.maxConnections }),
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
      throw new PortMapError('port_reserved', `port ${port} is used by tmex itself`);
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
    };
  }
}

let instance: PortMapManager | null = null;

/** 网关级单例：路由与 runtime 生命周期都用它，链路由 mesh 绑定后按 nodeId 解析。 */
export function portMapManager(): PortMapManager {
  instance ??= new PortMapManager({ store: new PortMapStore(getDb()) });
  return instance;
}

export function startPortMaps(): void {
  portMapManager().start();
}

export function stopPortMaps(): void {
  instance?.stop();
}
