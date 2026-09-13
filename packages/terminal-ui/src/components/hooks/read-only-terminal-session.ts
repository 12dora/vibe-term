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
import { measureElementRect, resolveInitialTerminalGrid } from '../terminal-initial-grid';
import { attachTerminalWithLatestTheme } from '../theme';

/** 与 `useTerminalBootSurface` 的 TERMINAL_SCROLLBACK 对齐 */
export const READ_ONLY_TERMINAL_SCROLLBACK = 10000;

const PAN_VIEWPORT_SELECTOR = '[data-pan-viewport="true"]';

export type ReadOnlyController = CompatibleTerminalLike & {
  dispose(): void;
  open(element: HTMLElement): void;
};

export interface ReadOnlyTerminalHandle {
  write(data: Uint8Array | string): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  fit(): void;
  scrollToOrigin(): void;
}

export interface FitAddonLike {
  fit(): void;
  dispose(): void;
  activate(terminal: CompatibleTerminalLike): void;
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
  mount: { getBoundingClientRect(): { width: number; height: number } } | null;
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

export function mountHasPositiveSize(element: {
  getBoundingClientRect(): { width: number; height: number };
}): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function fitThenEnablePan(
  term: { setViewportPan?: (enabled: boolean) => void },
  fit: { fit(): void }
): void {
  fit.fit();
  term.setViewportPan?.(true);
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

  noteResizeConsumed(): void {
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

export class ReadOnlyTerminalSession {
  readonly handle: ReadOnlyTerminalHandle;
  private term: ReadOnlyController | null;
  private fit: FitAddonLike | null;
  private panApplied = false;
  private recordedSize = false;
  private viewport: PanViewport | null = null;
  private readonly origin = new PanOriginPolicy();
  private readonly unbindScroll: Array<() => void> = [];

  constructor(
    private readonly viewportPan: boolean,
    term: ReadOnlyController,
    fit: FitAddonLike,
    private readonly mount: HTMLElement
  ) {
    this.term = term;
    this.fit = fit;
    this.handle = {
      write: (data) => {
        this.term?.write(data);
      },
      resize: (cols, rows) => this.resizeGrid(cols, rows),
      reset: () => {
        this.term?.reset();
      },
      fit: () => {
        this.fit?.fit();
      },
      scrollToOrigin: () => this.scrollToOrigin(),
    };
  }

  get controller(): ReadOnlyController | null {
    return this.term;
  }

  tryFitToContainer(): void {
    if (!this.term || !this.fit || !mountHasPositiveSize(this.mount)) return;
    if (this.viewportPan) {
      if (this.recordedSize || this.panApplied) return;
      fitThenEnablePan(this.term, this.fit);
      this.panApplied = true;
      this.bindViewport();
      return;
    }
    this.fit.fit();
  }

  dispose(): void {
    for (const unbind of this.unbindScroll.splice(0)) unbind();
    this.fit?.dispose();
    this.fit = null;
    this.term?.dispose();
    this.term = null;
    this.viewport = null;
  }

  private resizeGrid(cols: number, rows: number): void {
    this.term?.resize(cols, rows);
    this.recordedSize = true;
    if (!this.viewportPan || !this.term) return;
    if (!this.panApplied) {
      this.term.setViewportPan?.(true);
      this.panApplied = true;
      this.bindViewport();
    }
    if (this.origin.shouldResetOrigin()) this.scrollToOrigin();
    this.origin.noteResizeConsumed();
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
  const session = new ReadOnlyTerminalSession(input.viewportPan, term, fit, input.mount);
  session.tryFitToContainer();
  return session;
}
