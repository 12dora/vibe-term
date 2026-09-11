import type { GatewayPaneScreenSnapshot, GatewayRebaseReason } from '@vibeterm/ws-client';
import type { SnapshotCommitInfo, TerminalSurfaceTarget } from '../TerminalSurface';
import type { TerminalDiagnosticStage } from '../terminal-diagnostics';
import { markFirstTerminalScreenPainted } from './terminal-surface-lifecycle-signal';

export const TERMINAL_RESOURCE_ERROR_MESSAGE = 'Terminal resources failed to load.';
export const TERMINAL_INIT_ERROR_MESSAGE = 'Terminal failed to initialize.';
export const TERMINAL_RECOVERY_ERROR_MESSAGE =
  'Terminal rendering failed before the first screen was ready.';

export type TerminalBootState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export type TerminalLifecycleStage = Extract<
  TerminalDiagnosticStage,
  'mount' | 'fonts_ready' | 'font_load_failed' | 'recovery_started' | 'generation_activated'
>;

export interface TerminalSurfaceCreationContext<Target> {
  isCancelled(): boolean;
  onRecoveryRequired(reason: GatewayRebaseReason): void;
  onSnapshotApplied(
    target: Target,
    snapshot: GatewayPaneScreenSnapshot | null,
    commit: SnapshotCommitInfo
  ): void;
}

export interface TerminalSurfaceHandle<Target> {
  initialize(): Promise<Target>;
  dispose(): void;
  getVisibleTarget(): Target | null;
}

export interface TerminalSurfaceLifecycleDeps<
  Target extends TerminalSurfaceTarget,
  Surface extends TerminalSurfaceHandle<Target> = TerminalSurfaceHandle<Target>,
> {
  /** 返回 void 表示资源已就绪（同步路径），调用方据此免去一次 await */
  loadResources(): Promise<void> | void;
  /**
   * 启动二段资源（Nerd 图标等后到的字形）并返回到达信号，null 表示本次没有二段。
   * 只在首屏落地之后调用：提前开拉会跟首帧必需的字节抢带宽。
   */
  startResourceUpgrade?(): Promise<void> | null;
  /** 二段资源到达后的一次重测/重绘；没有可见代时不调用 */
  onResourcesUpgraded?(target: Target): void;
  createSurface(context: TerminalSurfaceCreationContext<Target>): Surface;
  getSurface(): Surface | null;
  setSurface(surface: Surface | null): void;
  /** 把当前可见代接到 React 侧（instance state），null 表示当前没有可见代 */
  bindTarget(target: Target | null): void;
  setBootState(state: TerminalBootState): void;
  reportStage(stage: TerminalLifecycleStage, target: Target | null): void;
  startDiagnosticSamples(target: Target): () => void;
  supportsAtomicScreen(): boolean;
  requestPaneScreen(): void;
  /** 快照按自带尺寸解析完毕后的尺寸收敛 */
  onSnapshotCommitted(target: Target): void;
}

// 启动态在 React 里是 useState 的值：每次都新建对象的话，history 每到一页都会让整棵
// 终端子树重渲染一次。无参数的两个终态用常量单例，setState 靠 Object.is 直接短路。
export const LOADING_BOOT_STATE: TerminalBootState = { status: 'loading' };
export const READY_BOOT_STATE: TerminalBootState = { status: 'ready' };

export function bootErrorState(error: unknown, fallback: string): TerminalBootState {
  return { status: 'error', message: error instanceof Error ? error.message : fallback };
}

/**
 * 恢复期的启动态：首屏已提交、或链路本身不做整屏原子下发时，恢复对启动态没有影响；
 * 否则回到 Loading，重试耗尽（resource_exhausted）则落到硬失败。
 */
export function recoveryBootState(input: {
  reason: GatewayRebaseReason;
  hasCommittedSnapshot: boolean;
  atomicScreen: boolean;
}): TerminalBootState | null {
  if (input.hasCommittedSnapshot || !input.atomicScreen) return null;
  return input.reason === 'resource_exhausted'
    ? { status: 'error', message: TERMINAL_RECOVERY_ERROR_MESSAGE }
    : LOADING_BOOT_STATE;
}

export function snapshotBootState(input: {
  hasSnapshot: boolean;
  atomicScreen: boolean;
}): TerminalBootState {
  return input.atomicScreen && !input.hasSnapshot ? LOADING_BOOT_STATE : READY_BOOT_STATE;
}

/**
 * 终端启动/恢复状态机：资源加载 → 渲染面建立 → 首屏落地，以及被取消后的静默收尾。
 * 全部副作用经 deps 注入，本身不碰 React、DOM 与 ghostty。
 *
 * 时序上有两处刻意的并行（冷启动 2 Mbps 下就是十几秒的差别）：
 * 1. `loadResources()` 在发起字体那一段的同时把 ghostty wasm 也预热了（见 terminal-fonts-cache），
 *    wasm 不再排在字体之后串行下载；
 * 2. 首帧只等「能精确测宽」的那一段字形，Nerd 图标经 `awaitResourceUpgrade()` 后到再重绘。
 */
export class TerminalSurfaceLifecycle<
  Target extends TerminalSurfaceTarget,
  Surface extends TerminalSurfaceHandle<Target> = TerminalSurfaceHandle<Target>,
> {
  private cancelled = false;
  private hasCommittedSnapshot = false;
  private resourceUpgradeWatched = false;
  private stopDiagnosticSamples: () => void = () => {};

  constructor(private readonly deps: TerminalSurfaceLifecycleDeps<Target, Surface>) {}

  isCancelled(): boolean {
    return this.cancelled;
  }

  async boot(): Promise<void> {
    this.deps.setSurface(null);
    this.deps.bindTarget(null);
    this.deps.setBootState(LOADING_BOOT_STATE);
    this.deps.reportStage('mount', null);

    const resources = this.loadResources();
    if (resources !== true && !(await resources)) return;
    if (this.cancelled) return;
    this.deps.reportStage('fonts_ready', null);

    const surface = this.deps.createSurface({
      isCancelled: () => this.cancelled,
      onRecoveryRequired: (reason) => this.handleRecoveryRequired(reason),
      onSnapshotApplied: (target, snapshot, commit) =>
        this.handleSnapshotApplied(target, snapshot, commit),
    });
    this.deps.setSurface(surface);
    try {
      await surface.initialize();
    } catch (error) {
      if (this.cancelled) return;
      this.deps.setBootState(bootErrorState(error, TERMINAL_INIT_ERROR_MESSAGE));
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.stopDiagnosticSamples();
    const surface = this.deps.getSurface();
    if (surface) surface.dispose();
    if (this.deps.getSurface() === surface) this.deps.setSurface(null);
    this.deps.bindTarget(null);
  }

  private loadResources(): boolean | Promise<boolean> {
    let pending: Promise<void> | void;
    try {
      pending = this.deps.loadResources();
    } catch (error) {
      return this.failResources(error);
    }
    if (!pending) return true;
    return pending.then(
      () => true,
      (error: unknown) => this.failResources(error)
    );
  }

  /**
   * 首屏落地之后才启动二段字形（Nerd 图标 / 符号兜底），到达后重绘一次：
   * 首帧时它们还是系统兜底字形，canvas 已经画下去的那一屏不会自己更新。
   * 失败静默——降级只是图标不好看。
   */
  private watchResourceUpgrade(): void {
    if (this.resourceUpgradeWatched) return;
    this.resourceUpgradeWatched = true;
    const upgrade = this.deps.startResourceUpgrade?.();
    if (!upgrade) return;
    void upgrade
      .then(() => {
        if (this.cancelled) return;
        const target = this.deps.getSurface()?.getVisibleTarget() ?? null;
        if (target) this.deps.onResourcesUpgraded?.(target);
      })
      .catch(() => undefined);
  }

  private failResources(error: unknown): false {
    this.deps.reportStage('font_load_failed', null);
    if (!this.cancelled) {
      this.deps.setBootState(bootErrorState(error, TERMINAL_RESOURCE_ERROR_MESSAGE));
    }
    return false;
  }

  private handleRecoveryRequired(reason: GatewayRebaseReason): void {
    if (this.cancelled) return;
    this.deps.reportStage('recovery_started', this.deps.getSurface()?.getVisibleTarget() ?? null);
    const next = recoveryBootState({
      reason,
      hasCommittedSnapshot: this.hasCommittedSnapshot,
      atomicScreen: this.deps.supportsAtomicScreen(),
    });
    if (next) this.deps.setBootState(next);
    this.deps.requestPaneScreen();
  }

  private handleSnapshotApplied(
    target: Target,
    snapshot: GatewayPaneScreenSnapshot | null,
    commit: SnapshotCommitInfo
  ): void {
    if (this.cancelled) return;
    this.deps.bindTarget(target);
    const firstSnapshot = snapshot !== null && !this.hasCommittedSnapshot;
    if (snapshot) {
      this.hasCommittedSnapshot = true;
      // 尺寸收敛只在快照真的改了网格时才需要：history 每页重排都写回同一尺寸，
      // 无差异时再跑一遍就是每页多发一条强制 terminal-sync-size。
      if (firstSnapshot || commit.gridResized) this.deps.onSnapshotCommitted(target);
      this.deps.reportStage('generation_activated', target);
      // 外壳的空闲预热要等这一刻（见 ./terminal-surface-lifecycle-signal）
      markFirstTerminalScreenPainted();
      // 二段字形同理：首屏出来之前不跟它抢带宽
      if (firstSnapshot) this.watchResourceUpgrade();
    }
    this.deps.setBootState(
      snapshotBootState({
        hasSnapshot: snapshot !== null,
        atomicScreen: this.deps.supportsAtomicScreen(),
      })
    );
    // 采样窗口只在建面与首屏落地时重开；每页重排都重挂三个定时器的话采样点永远打不出去
    if (snapshot === null || firstSnapshot) {
      this.stopDiagnosticSamples();
      this.stopDiagnosticSamples = this.deps.startDiagnosticSamples(target);
    }
  }
}
