import type { GatewayPaneScreenSnapshot, GatewayRebaseReason } from '@tmex/ws-client';
import type { TerminalSurfaceTarget } from '../TerminalSurface';
import type { TerminalDiagnosticStage } from '../terminal-diagnostics';

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
  onSnapshotApplied(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void;
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
    : { status: 'loading' };
}

export function snapshotBootState(input: {
  hasSnapshot: boolean;
  atomicScreen: boolean;
}): TerminalBootState {
  return input.atomicScreen && !input.hasSnapshot ? { status: 'loading' } : { status: 'ready' };
}

/**
 * 终端启动/恢复状态机：资源加载 → 渲染面建立 → 首屏落地，以及被取消后的静默收尾。
 * 全部副作用经 deps 注入，本身不碰 React、DOM 与 ghostty。
 */
export class TerminalSurfaceLifecycle<
  Target extends TerminalSurfaceTarget,
  Surface extends TerminalSurfaceHandle<Target> = TerminalSurfaceHandle<Target>,
> {
  private cancelled = false;
  private hasCommittedSnapshot = false;
  private stopDiagnosticSamples: () => void = () => {};

  constructor(private readonly deps: TerminalSurfaceLifecycleDeps<Target, Surface>) {}

  isCancelled(): boolean {
    return this.cancelled;
  }

  async boot(): Promise<void> {
    this.deps.setSurface(null);
    this.deps.bindTarget(null);
    this.deps.setBootState({ status: 'loading' });
    this.deps.reportStage('mount', null);

    const resources = this.loadResources();
    if (resources !== true && !(await resources)) return;
    if (this.cancelled) return;
    this.deps.reportStage('fonts_ready', null);

    const surface = this.deps.createSurface({
      isCancelled: () => this.cancelled,
      onRecoveryRequired: (reason) => this.handleRecoveryRequired(reason),
      onSnapshotApplied: (target, snapshot) => this.handleSnapshotApplied(target, snapshot),
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

  private handleSnapshotApplied(target: Target, snapshot: GatewayPaneScreenSnapshot | null): void {
    if (this.cancelled) return;
    this.deps.bindTarget(target);
    if (snapshot) {
      this.hasCommittedSnapshot = true;
      this.deps.onSnapshotCommitted(target);
      this.deps.reportStage('generation_activated', target);
    }
    this.deps.setBootState(
      snapshotBootState({
        hasSnapshot: snapshot !== null,
        atomicScreen: this.deps.supportsAtomicScreen(),
      })
    );
    this.stopDiagnosticSamples();
    this.stopDiagnosticSamples = this.deps.startDiagnosticSamples(target);
  }
}
