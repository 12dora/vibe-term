import type { TerminalThemeColors } from '@vibeterm/shared';
import {
  type ThemePreset,
  loadTerminalFonts,
  resolveFontStack,
  resolveTerminalTheme,
} from '@vibeterm/theme';
import {
  type CompatibleTerminalLike,
  FitAddon,
  type GhosttyTerminalInitOptions,
  createTerminalController,
  isMacPlatform,
} from 'ghostty-terminal';
import { normalizeLiveOutputForTerminal } from '../normalization';
import {
  type MeasurableElement,
  measureElementRect,
  resolveInitialTerminalGrid,
} from '../terminal-initial-grid';
import { attachTerminalWithLatestTheme } from '../theme';

/** 与 `useTerminalBootSurface` 的 TERMINAL_SCROLLBACK 对齐 */
export const READ_ONLY_TERMINAL_SCROLLBACK = 10000;

const PAN_VIEWPORT_SELECTOR = '[data-pan-viewport="true"]';
const TEXT_ENCODER = new TextEncoder();

export type ReadOnlyController = CompatibleTerminalLike & {
  dispose(): void;
  open(element: HTMLElement): void;
};

export interface ReadOnlyTerminalHandle {
  write(data: Uint8Array | string): void;
  /**
   * 写入一份录制快照。快照的字节是按录制时的网格拼的（primary 屏还带着 history 与绝对 CUP），
   * 必须先把仿真终端调回那个网格再写，写完调回生效网格——就像真终端被拉大：
   * primary 屏把 history 拉回 scrollback（提示行仍在底部），alt 屏的 TUI 画面留在左上。
   */
  writeCheckpoint(data: Uint8Array | string, grid: ReadOnlyGrid): void;
  reset(): void;
}

export interface ReadOnlyGrid {
  cols: number;
  rows: number;
}

export interface FitAddonLike {
  dispose(): void;
  activate(terminal: CompatibleTerminalLike): void;
  /** 容器能放下多少行列（不改终端，只算）。 */
  proposeDimensions(): ReadOnlyGrid | null;
}

export interface PanViewport {
  scrollLeft: number;
  scrollTop: number;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export interface ReadOnlyTerminalSettings {
  fontId: string;
  fontSize: number;
  lineHeight: number;
  theme: TerminalThemeColors;
}

export function readOnlyTerminalSettingsFromUi(state: {
  terminalFontId: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  theme: 'light' | 'dark';
  themePreset: ThemePreset | null;
}): ReadOnlyTerminalSettings {
  return {
    fontId: state.terminalFontId,
    fontSize: state.terminalFontSize,
    lineHeight: state.terminalLineHeight,
    theme: resolveTerminalTheme(state.theme, state.themePreset),
  };
}

export function buildReadOnlyControllerOptions(input: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  theme: TerminalThemeColors;
  mount: MeasurableElement | null;
}): GhosttyTerminalInitOptions {
  const grid = resolveInitialTerminalGrid({
    rect: measureElementRect(input.mount),
    fontSize: input.fontSize,
    lineHeight: input.lineHeight,
  });
  return {
    fontFamily: input.fontFamily,
    fontSize: input.fontSize,
    lineHeight: input.lineHeight,
    scrollback: input.scrollback,
    cols: grid.cols,
    rows: grid.rows,
    theme: input.theme,
    disableStdin: true,
  };
}

export function mountHasPositiveSize(element: MeasurableElement): boolean {
  return measureElementRect(element) !== null;
}

export function sameReadOnlyGrid(a: ReadOnlyGrid | null, b: ReadOnlyGrid | null): boolean {
  if (a === null || b === null) return a === b;
  return a.cols === b.cols && a.rows === b.rows;
}

type OpenAncestor = {
  addEventListener(type: 'animationend', listener: () => void): void;
  removeEventListener(type: 'animationend', listener: () => void): void;
  getAnimations?: () => Array<{ playState?: string }>;
};

function openAncestorIsAnimating(host: OpenAncestor): boolean {
  if (typeof host.getAnimations !== 'function') return true;
  return host.getAnimations().some((item) => {
    const state = item.playState;
    return state === 'running' || state === 'pending';
  });
}

/** 首次绘制后再 fit 一次：dialog `zoom-in-95` 期间 getBoundingClientRect 会偏小。 */
export function schedulePostPaintRefit(
  element: { closest?(selector: string): OpenAncestor | null } | null,
  run: () => void
): () => void {
  const rAF = globalThis.requestAnimationFrame?.bind(globalThis);
  const cancel = globalThis.cancelAnimationFrame?.bind(globalThis);
  if (typeof rAF !== 'function') return () => {};
  let cancelled = false;
  let id1 = 0;
  let id2 = 0;
  let host: OpenAncestor | null = null;
  const fire = () => {
    if (!cancelled) run();
  };
  const onEnd = () => {
    host?.removeEventListener('animationend', onEnd);
    host = null;
    fire();
  };
  id1 = rAF(() => {
    if (cancelled) return;
    host = element?.closest?.('[data-open]') ?? null;
    if (host) host.addEventListener('animationend', onEnd);
    if (!host || !openAncestorIsAnimating(host)) id2 = rAF(fire);
  });
  return () => {
    cancelled = true;
    cancel?.(id1);
    cancel?.(id2);
    host?.removeEventListener('animationend', onEnd);
  };
}

/** 生效网格 = 容器能放下的 ∪ 录像包络：窗口更大就铺满窗口，录像更大就按录像来（多出的部分平移查看）。 */
export function unionReadOnlyGrid(
  fitted: ReadOnlyGrid,
  minGrid: ReadOnlyGrid | null
): ReadOnlyGrid {
  if (!minGrid) return fitted;
  return {
    cols: Math.max(fitted.cols, minGrid.cols),
    rows: Math.max(fitted.rows, minGrid.rows),
  };
}

export function queryPanViewport(
  root: { querySelector(selector: string): unknown } | null
): PanViewport | null {
  const found = root?.querySelector(PAN_VIEWPORT_SELECTOR);
  return found ? (found as PanViewport) : null;
}

export function isReadOnlyCopyShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (event.altKey || event.key.toLowerCase() !== 'c') return false;
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

export class PanOriginPolicy {
  private userHasPanned = false;
  private suppress = false;

  onScroll(scrollLeft: number, scrollTop: number): void {
    if (this.suppress) return;
    if (scrollLeft !== 0 || scrollTop !== 0) this.userHasPanned = true;
  }

  shouldResetOrigin(): boolean {
    return !this.userHasPanned;
  }

  reset(): void {
    this.userHasPanned = false;
  }

  runProgrammatic(fn: () => void): void {
    this.suppress = true;
    try {
      fn();
    } finally {
      this.suppress = false;
    }
  }
}

export interface ReadOnlySessionOptions {
  /** 录像包络：生效网格不会小于它。 */
  minGrid?: ReadOnlyGrid | null;
  /** 生效网格变了（开面那次不算）：回放据此清屏重放，否则 ghostty 的 reflow 会把 TUI 画面搅乱。 */
  onGridChange?: (cols: number, rows: number) => void;
}

export class ReadOnlyTerminalSession {
  readonly handle: ReadOnlyTerminalHandle;
  private term: ReadOnlyController | null;
  private fit: FitAddonLike | null;
  private panApplied = false;
  private grid: ReadOnlyGrid | null = null;
  private minGrid: ReadOnlyGrid | null;
  private viewport: PanViewport | null = null;
  private readonly origin = new PanOriginPolicy();
  private readonly unbindScroll: Array<() => void> = [];
  private unbindDeferredRefit: (() => void) | null = null;
  private readonly onGridChange?: (cols: number, rows: number) => void;
  /** 上一块字节是不是以 CR 收尾：补 CR 要跨块接续，和 live 输出同一套状态机。 */
  private endedWithCR = false;

  constructor(
    private readonly viewportPan: boolean,
    term: ReadOnlyController,
    fit: FitAddonLike,
    private readonly mount: HTMLElement,
    options?: ReadOnlySessionOptions
  ) {
    this.term = term;
    this.fit = fit;
    this.minGrid = options?.minGrid ?? null;
    this.onGridChange = options?.onGridChange;
    this.handle = {
      write: (data) => this.writeNormalized(data),
      writeCheckpoint: (data, grid) => this.writeAtRecordedGrid(data, grid),
      reset: () => {
        this.origin.reset();
        this.endedWithCR = false;
        this.term?.reset();
        // 清屏之后内容要从左上角重写：不滚回原点的话会在旧偏移下重画，看着像丢了一截。
        this.scrollToOrigin();
      },
    };
  }

  get controller(): ReadOnlyController | null {
    return this.term;
  }

  /** 当前生效网格；还没量到容器时为 null。 */
  get effectiveGrid(): ReadOnlyGrid | null {
    return this.grid;
  }

  /** 容器尺寸变了就重算：和普通终端一样跟着窗口走，不再被「录像尺寸已到」卡死。 */
  tryFitToContainer(): void {
    this.applyGrid();
  }

  /**
   * 录像包络变了（日志又来一页 / 换 pane）。
   * `silent` 用于开面到就绪之间的补齐：那时上层还没拿到 handle，不该当成一次「网格变化」。
   */
  setMinGrid(next: ReadOnlyGrid | null, silent = false): void {
    if (sameReadOnlyGrid(this.minGrid, next)) return;
    this.minGrid = next ? { cols: next.cols, rows: next.rows } : null;
    this.applyGrid(silent);
  }

  dispose(): void {
    this.unbindDeferredRefit?.();
    this.unbindDeferredRefit = null;
    for (const unbind of this.unbindScroll.splice(0)) unbind();
    this.fit?.dispose();
    this.fit = null;
    this.term?.dispose();
    this.term = null;
    this.viewport = null;
  }

  private armDeferredRefit(): void {
    this.unbindDeferredRefit?.();
    this.unbindDeferredRefit = schedulePostPaintRefit(this.mount, () => {
      this.unbindDeferredRefit = null;
      this.applyGrid();
    });
  }

  /** 按「容器 ∪ 包络」下发网格；没变就什么都不做，变了才通知上层重放。 */
  private applyGrid(silent = false): void {
    if (!this.term || !this.fit || !mountHasPositiveSize(this.mount)) return;
    const fitted = this.fit.proposeDimensions();
    if (!fitted) return;
    const next = unionReadOnlyGrid(fitted, this.minGrid);
    if (sameReadOnlyGrid(this.grid, next)) return;
    const booting = this.grid === null;
    this.grid = next;
    this.term.resize(next.cols, next.rows);
    if (this.viewportPan) this.enablePan();
    if (this.origin.shouldResetOrigin()) this.scrollToOrigin();
    if (booting) this.armDeferredRefit();
    else if (!silent) this.onGridChange?.(next.cols, next.rows);
  }

  /**
   * 在录制网格下写快照，写完调回生效网格。两次 resize 与 write 都是同步进 wasm 的，
   * 中间不会渲染，也不动 minGrid / 平移状态，更不上报网格变化——这不是窗口变了。
   */
  private writeAtRecordedGrid(data: Uint8Array | string, grid: ReadOnlyGrid): void {
    const term = this.term;
    if (!term) return;
    const effective = this.grid;
    if (sameReadOnlyGrid(effective, grid)) {
      this.writeNormalized(data);
      return;
    }
    term.resize(grid.cols, grid.rows);
    this.writeNormalized(data);
    if (effective) term.resize(effective.cols, effective.rows);
  }

  /**
   * 裸 LF 补 CR 后再写。录像里的 checkpoint / history 都是 gateway 用 '\n' 拼的行，
   * 直接喂给终端会阶梯式换行——live 输出走的是同一个规整器（terminal-snapshot.ts）。
   * 返回的缓冲可能是复用的暂存区视图，必须同步交给 write 消费掉。
   */
  private writeNormalized(data: Uint8Array | string): void {
    const term = this.term;
    if (!term) return;
    const bytes = typeof data === 'string' ? TEXT_ENCODER.encode(data) : data;
    const result = normalizeLiveOutputForTerminal(bytes, this.endedWithCR);
    this.endedWithCR = result.endedWithCR;
    term.write(result.normalized);
  }

  private enablePan(): void {
    if (this.panApplied || !this.term) return;
    this.term.setViewportPan?.(true);
    this.panApplied = true;
    this.bindViewport();
  }

  private bindViewport(): void {
    const viewport = queryPanViewport(this.term?.element ?? this.mount);
    this.viewport = viewport;
    if (!viewport?.addEventListener) return;
    const onScroll = () => this.origin.onScroll(viewport.scrollLeft, viewport.scrollTop);
    viewport.addEventListener('scroll', onScroll);
    this.unbindScroll.push(() => viewport.removeEventListener?.('scroll', onScroll));
  }

  private scrollToOrigin(): void {
    const viewport = this.viewport ?? queryPanViewport(this.term?.element ?? this.mount);
    if (!viewport) return;
    this.origin.runProgrammatic(() => {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }
}

export interface ReadOnlyBootInput {
  mount: HTMLElement;
  fontId: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
  theme: TerminalThemeColors;
  viewportPan: boolean;
  isCancelled: () => boolean;
  termRef: { current: ReadOnlyController | null };
  themeRef: { current: TerminalThemeColors };
  /** 录像包络：生效网格不会小于它。 */
  minGrid?: ReadOnlyGrid | null;
  /** 建面完成那一刻的最新包络：异步建面期间日志可能又来一页，交出 session 前补齐。 */
  readMinGrid?: () => ReadOnlyGrid | null;
  onGridChange?: (cols: number, rows: number) => void;
  loadFonts?: (fontId: string, fontSize: number) => Promise<void>;
  createController?: (options: GhosttyTerminalInitOptions) => Promise<ReadOnlyController>;
  createFitAddon?: () => FitAddonLike;
}

export async function openReadOnlyController(
  input: ReadOnlyBootInput
): Promise<ReadOnlyController | null> {
  const loadFonts = input.loadFonts ?? loadTerminalFonts;
  const createController = input.createController ?? createTerminalController;
  try {
    await loadFonts(input.fontId, input.fontSize);
  } catch {
    // 字体失败不挡只读终端：退回系统等宽栈
  }
  if (input.isCancelled()) return null;
  const options = buildReadOnlyControllerOptions({
    fontFamily: resolveFontStack(input.fontId),
    fontSize: input.fontSize,
    lineHeight: input.lineHeight,
    scrollback: input.scrollback,
    theme: input.theme,
    mount: input.mount,
  });
  let term: ReadOnlyController;
  try {
    term = await createController(options);
  } catch {
    return null;
  }
  if (input.isCancelled()) {
    term.dispose();
    return null;
  }
  try {
    term.open(input.mount);
  } catch {
    term.dispose();
    return null;
  }
  return term;
}

export async function bootReadOnlyTerminal(
  input: ReadOnlyBootInput
): Promise<ReadOnlyTerminalSession | null> {
  const term = await openReadOnlyController(input);
  if (!term || input.isCancelled()) {
    term?.dispose();
    return null;
  }
  attachTerminalWithLatestTheme(input.termRef, term, input.themeRef);
  const fit = (input.createFitAddon ?? (() => new FitAddon()))();
  term.loadAddon(fit);
  const session = new ReadOnlyTerminalSession(input.viewportPan, term, fit, input.mount, {
    minGrid: input.minGrid ?? null,
    onGridChange: input.onGridChange,
  });
  session.tryFitToContainer();
  // 建面是异步的（等字体 + 建控制器），这期间包络可能已经变大：交出 session 之前补齐，
  // 第一次快进就落在最终网格上。此时上层还没拿到 handle，不算一次「网格变化」。
  if (input.readMinGrid) session.setMinGrid(input.readMinGrid(), true);
  return session;
}
