import type {
  GatewayHistoryCursor,
  GatewayPaneHistoryPage,
  GatewayPaneScreenSnapshot,
  GatewayRebaseReason,
  GatewayTerminalData,
} from '@tmex/ws-client';
import {
  type TerminalHistoryCache,
  commitHistoryPage,
  copyHistoryCursor,
  validateHistoryPage,
} from './terminal-history-page';

const MAX_SURFACE_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_SURFACE_HISTORY_PAGES = 64;

export interface TerminalSurfaceTarget {
  dispose(): void;
}

export type TerminalSurfaceRecoveryState = 'initializing' | 'live' | 'recovering' | 'disposed';

export interface TerminalSurfaceDiagnosticState {
  paneEpoch: Uint8Array | null;
  historyEpoch: Uint8Array | null;
  historyBeforeLine: number | null;
  recoveryState: TerminalSurfaceRecoveryState;
  recoveryReason: GatewayRebaseReason | null;
  historyBytes: number;
  historyBytesLimit: number;
  historyPages: number;
  historyPagesLimit: number;
}

export interface TerminalSurfaceOptions<Target extends TerminalSurfaceTarget> {
  createTarget(): Promise<Target>;
  writeSnapshot(
    target: Target,
    snapshot: GatewayPaneScreenSnapshot,
    historyPages: readonly GatewayPaneHistoryPage[]
  ): void;
  writeLive(target: Target, data: Uint8Array): void;
  activate(target: Target): void;
  onRecoveryRequired(reason: GatewayRebaseReason): void;
  onSnapshotApplied?(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void;
  maxHistoryBytes?: number;
  maxHistoryPages?: number;
}

function copySnapshot(snapshot: GatewayPaneScreenSnapshot): GatewayPaneScreenSnapshot {
  return {
    ...snapshot,
    requestId: snapshot.requestId ? Uint8Array.from(snapshot.requestId) : undefined,
    paneEpoch: Uint8Array.from(snapshot.paneEpoch),
    data: Uint8Array.from(snapshot.data),
    historyCursor: copyHistoryCursor(snapshot.historyCursor),
  };
}

interface LiveHistoryContext<Target extends TerminalSurfaceTarget> {
  target: Target;
  snapshot: GatewayPaneScreenSnapshot;
  cursor: GatewayHistoryCursor;
}

/**
 * 单终端渲染面：字节直通，不做 seq/epoch 判定，也不缓存 live 用于重建。
 *
 * 缺口只认链路上报的 rebase —— 服务端（gateway/relay/companion）已经在做这件事，
 * 渲染层再判定一遍的唯一效果是：快照尚未落地时 visibleCursor 为空，
 * 于是所有 live 被静默丢弃，终端一片空白。
 *
 * 重取首屏时直接在当前终端上重写，用户可见一次闪屏（已拍板接受），
 * 换掉原先的离屏双缓冲与客户端 replay ring。
 */
export class TerminalSurface<Target extends TerminalSurfaceTarget> {
  private readonly cache: TerminalHistoryCache;
  private target: Target | null = null;
  private latestSnapshot: GatewayPaneScreenSnapshot | null = null;
  private nextHistoryCursor: GatewayHistoryCursor | null = null;
  private recoveryRequested = false;
  private recoveryReason: GatewayRebaseReason | null = null;
  private disposed = false;

  constructor(private readonly options: TerminalSurfaceOptions<Target>) {
    this.cache = {
      pages: [],
      bytes: 0,
      maxPages: options.maxHistoryPages ?? MAX_SURFACE_HISTORY_PAGES,
      maxBytes: options.maxHistoryBytes ?? MAX_SURFACE_HISTORY_BYTES,
    };
  }

  async initialize(): Promise<Target> {
    if (this.disposed) throw new Error('terminal surface disposed');
    if (this.target) return this.target;
    const target = await this.options.createTarget();
    if (this.disposed) {
      target.dispose();
      throw new Error('terminal surface disposed');
    }
    this.target = target;
    this.options.activate(target);
    this.options.onSnapshotApplied?.(target, null);
    return target;
  }

  getVisibleTarget(): Target | null {
    return this.target;
  }

  getNextHistoryCursor(): GatewayHistoryCursor | null {
    return copyHistoryCursor(this.nextHistoryCursor);
  }

  getDiagnosticState(): TerminalSurfaceDiagnosticState {
    return {
      paneEpoch: this.latestSnapshot ? Uint8Array.from(this.latestSnapshot.paneEpoch) : null,
      historyEpoch: this.nextHistoryCursor
        ? Uint8Array.from(this.nextHistoryCursor.historyEpoch)
        : null,
      historyBeforeLine: this.nextHistoryCursor?.beforeLine ?? null,
      recoveryState: this.disposed
        ? 'disposed'
        : this.recoveryRequested
          ? 'recovering'
          : this.target
            ? 'live'
            : 'initializing',
      recoveryReason: this.recoveryReason,
      historyBytes: this.cache.bytes,
      historyBytesLimit: this.cache.maxBytes,
      historyPages: this.cache.pages.length,
      historyPagesLimit: this.cache.maxPages,
    };
  }

  write(frame: GatewayTerminalData): void {
    if (this.disposed || !this.target) return;
    this.options.writeLive(this.target, frame.data);
  }

  replace(snapshot: GatewayPaneScreenSnapshot): void {
    if (this.disposed || !this.target) return;
    const owned = copySnapshot(snapshot);
    this.latestSnapshot = owned;
    this.cache.pages = [];
    this.cache.bytes = 0;
    this.nextHistoryCursor = copyHistoryCursor(owned.historyCursor);
    this.recoveryRequested = false;
    this.recoveryReason = null;
    this.options.writeSnapshot(this.target, owned, []);
    this.options.onSnapshotApplied?.(this.target, owned);
  }

  applyHistoryPage(page: GatewayPaneHistoryPage): boolean {
    const live = this.liveHistoryContext();
    if (!live) return false;
    const decision = validateHistoryPage(page, live.snapshot, live.cursor, this.cache);
    if (decision.status === 'invalid') {
      this.requestRecovery(decision.recoveryReason);
      return false;
    }
    if (decision.status === 'limit') {
      this.nextHistoryCursor = null;
      return false;
    }
    this.nextHistoryCursor = commitHistoryPage(this.cache, page);
    this.options.writeSnapshot(live.target, live.snapshot, this.cache.pages);
    this.options.onSnapshotApplied?.(live.target, live.snapshot);
    return true;
  }

  private liveHistoryContext(): LiveHistoryContext<Target> | null {
    const target = this.target;
    const snapshot = this.latestSnapshot;
    const cursor = this.nextHistoryCursor;
    if (this.disposed || !target || !snapshot || !cursor) return null;
    return { target, snapshot, cursor };
  }

  rebase(reason: GatewayRebaseReason): void {
    if (this.disposed) return;
    this.requestRecovery(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.target?.dispose();
    this.target = null;
    this.latestSnapshot = null;
    this.cache.pages = [];
    this.cache.bytes = 0;
  }

  private requestRecovery(reason: GatewayRebaseReason): void {
    const changed = this.recoveryReason !== reason;
    this.recoveryReason = reason;
    // 同一 reason 的恢复请求在途时抑制重复请求，避免请求风暴；但 reason 变化必须继续上报：
    // 首屏一直取不回来时，重试耗尽后的 resource_exhausted 正是靠这条路径把失败态交给渲染层，
    // 被吞掉就只能永远停在 Loading。
    if (this.recoveryRequested && !changed) return;
    this.recoveryRequested = true;
    this.options.onRecoveryRequired(reason);
  }
}
