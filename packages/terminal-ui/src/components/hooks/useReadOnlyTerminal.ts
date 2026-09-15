import type { TerminalThemeColors } from '@vibeterm/shared';
import { useUIStore } from '@vibeterm/stores/react';
import { resolveTerminalTheme } from '@vibeterm/theme';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { applyTerminalTheme } from '../theme';
import type { ReadOnlyGrid, ReadOnlyTerminalHandle } from './read-only-terminal-session';
import {
  type ReadOnlyBootInput,
  type ReadOnlyController,
  type ReadOnlyTerminalSession,
  bootReadOnlyTerminal,
} from './read-only-terminal-session';

/** 拖动窗口一路触发 resize：等手停下来再重算网格，否则回放会被整份重放拖垮。 */
const CONTAINER_REFIT_DEBOUNCE_MS = 150;

export interface UseReadOnlyTerminalOptions {
  viewportPan: boolean;
  /** 覆盖设置里的终端字号；不给就用设置值。 */
  fontSize?: number;
  /** 生效网格的下界（录像包络）；容器更大时以容器为准。 */
  minGrid?: ReadOnlyGrid | null;
  onGridChange?: (cols: number, rows: number) => void;
  scrollback: number;
  onReady?: (handle: ReadOnlyTerminalHandle) => void;
  onDispose?: () => void;
}

export interface ReadOnlyTerminalRefs {
  containerRef: RefObject<HTMLElement | null>;
  mountRef: RefObject<HTMLDivElement | null>;
  instance: CompatibleTerminalLike | null;
  terminalTheme: TerminalThemeColors;
}

interface ReadOnlyE2eGlobals {
  __vibetermE2eReadOnlyTerminal: CompatibleTerminalLike | null;
  __vibetermE2eReadOnlyTerminalSelectionText: string | null;
}

function readOnlyE2eGlobals(): ReadOnlyE2eGlobals {
  return globalThis as unknown as ReadOnlyE2eGlobals;
}

function selectionTextOf(terminal: CompatibleTerminalLike): string | null {
  return terminal.hasSelection?.() ? (terminal.getSelection?.() ?? null) : null;
}

/** e2e 探针：与 `useTerminalBootSurface` 同一套无条件写入，生产 dist 也能读。 */
export function setE2eReadOnlyTerminalProbe(terminal: CompatibleTerminalLike): void {
  const g = readOnlyE2eGlobals();
  g.__vibetermE2eReadOnlyTerminal = terminal;
  g.__vibetermE2eReadOnlyTerminalSelectionText = selectionTextOf(terminal);
}

export function clearE2eReadOnlyTerminalProbe(terminal: CompatibleTerminalLike | null): void {
  const g = readOnlyE2eGlobals();
  if (terminal && g.__vibetermE2eReadOnlyTerminal !== terminal) return;
  g.__vibetermE2eReadOnlyTerminal = null;
  g.__vibetermE2eReadOnlyTerminalSelectionText = null;
}

function useReadOnlyContainerFit(
  containerRef: RefObject<HTMLElement | null>,
  sessionRef: RefObject<ReadOnlyTerminalSession | null>
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        sessionRef.current?.tryFitToContainer();
      }, CONTAINER_REFIT_DEBOUNCE_MS);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [containerRef, sessionRef]);
}

/** 包络变化按值比较下发：每页日志都会造出一个新对象，按引用比较会白白重算网格。 */
function useReadOnlyMinGrid(
  sessionRef: RefObject<ReadOnlyTerminalSession | null>,
  minGrid: ReadOnlyGrid | null | undefined
): void {
  const cols = minGrid?.cols ?? 0;
  const rows = minGrid?.rows ?? 0;
  useEffect(() => {
    sessionRef.current?.setMinGrid(cols > 0 && rows > 0 ? { cols, rows } : null);
  }, [sessionRef, cols, rows]);
}

function useReadOnlyE2eProbe(instance: CompatibleTerminalLike | null): void {
  useEffect(() => {
    if (!instance) {
      clearE2eReadOnlyTerminalProbe(null);
      return;
    }
    setE2eReadOnlyTerminalProbe(instance);
    const disposable = instance.onSelectionChange?.((text) => {
      const g = readOnlyE2eGlobals();
      if (g.__vibetermE2eReadOnlyTerminal !== instance) return;
      g.__vibetermE2eReadOnlyTerminalSelectionText = text;
    });
    return () => {
      disposable?.dispose();
      clearE2eReadOnlyTerminalProbe(instance);
    };
  }, [instance]);
}

export function useReadOnlyTerminal(options: UseReadOnlyTerminalOptions): ReadOnlyTerminalRefs {
  const fontId = useUIStore((state) => state.terminalFontId);
  const storeFontSize = useUIStore((state) => state.terminalFontSize);
  const fontSize = options.fontSize ?? storeFontSize;
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const theme = useUIStore((state) => state.theme);
  const themePreset = useUIStore((state) => state.themePreset);
  const terminalTheme = useMemo(
    () => resolveTerminalTheme(theme, themePreset),
    [theme, themePreset]
  );

  const containerRef = useRef<HTMLElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<ReadOnlyController | null>(null);
  const themeRef = useRef(terminalTheme);
  themeRef.current = terminalTheme;
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  const onDisposeRef = useRef(options.onDispose);
  onDisposeRef.current = options.onDispose;
  const onGridChangeRef = useRef(options.onGridChange);
  onGridChangeRef.current = options.onGridChange;
  const minGridRef = useRef(options.minGrid);
  minGridRef.current = options.minGrid;
  const sessionRef = useRef<ReadOnlyTerminalSession | null>(null);
  const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return undefined;
    const bootInput: ReadOnlyBootInput = {
      mount,
      fontId,
      fontSize,
      lineHeight,
      scrollback: options.scrollback,
      theme: themeRef.current,
      viewportPan: options.viewportPan,
      minGrid: minGridRef.current ?? null,
      readMinGrid: () => minGridRef.current ?? null,
      onGridChange: (cols, rows) => onGridChangeRef.current?.(cols, rows),
      isCancelled: () => cancelled,
      termRef,
      themeRef,
    };
    let notifiedReady = false;
    void bootReadOnlyTerminal(bootInput).then((session) => {
      if (!session || cancelled) {
        session?.dispose();
        return;
      }
      sessionRef.current = session;
      setInstance(session.controller);
      notifiedReady = true;
      onReadyRef.current?.(session.handle);
    });
    return () => {
      cancelled = true;
      if (notifiedReady) onDisposeRef.current?.();
      sessionRef.current?.dispose();
      sessionRef.current = null;
      termRef.current = null;
      setInstance(null);
    };
  }, [fontId, fontSize, lineHeight, options.scrollback, options.viewportPan]);

  // instance 进依赖：实例是异步建出来的，就绪那一刻要补下发一次主题。
  useEffect(() => {
    if (!instance) return;
    applyTerminalTheme(termRef.current, terminalTheme);
  }, [terminalTheme, instance]);

  useReadOnlyE2eProbe(instance);
  useReadOnlyContainerFit(containerRef, sessionRef);
  useReadOnlyMinGrid(sessionRef, options.minGrid);

  return { containerRef, mountRef, instance, terminalTheme };
}
