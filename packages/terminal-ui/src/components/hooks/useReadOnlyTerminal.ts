import type { TerminalThemeColors } from '@vibeterm/shared';
import { useUIStore } from '@vibeterm/stores/react';
import { resolveTerminalTheme } from '@vibeterm/theme';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { applyTerminalTheme } from '../theme';
import type { ReadOnlyTerminalHandle } from './read-only-terminal-session';
import {
  type ReadOnlyBootInput,
  type ReadOnlyController,
  type ReadOnlyTerminalSession,
  bootReadOnlyTerminal,
} from './read-only-terminal-session';

export interface UseReadOnlyTerminalOptions {
  viewportPan: boolean;
  scrollback: number;
  onReady?: (handle: ReadOnlyTerminalHandle) => void;
  onDispose?: () => void;
}

export interface ReadOnlyTerminalRefs {
  containerRef: RefObject<HTMLDivElement | null>;
  mountRef: RefObject<HTMLDivElement | null>;
  instance: CompatibleTerminalLike | null;
  terminalTheme: TerminalThemeColors;
}

function useReadOnlyContainerFit(
  containerRef: RefObject<HTMLDivElement | null>,
  sessionRef: RefObject<ReadOnlyTerminalSession | null>
): void {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        sessionRef.current?.tryFitToContainer();
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [containerRef, sessionRef]);
}

export function useReadOnlyTerminal(options: UseReadOnlyTerminalOptions): ReadOnlyTerminalRefs {
  const fontId = useUIStore((state) => state.terminalFontId);
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const theme = useUIStore((state) => state.theme);
  const themePreset = useUIStore((state) => state.themePreset);
  const terminalTheme = useMemo(
    () => resolveTerminalTheme(theme, themePreset),
    [theme, themePreset]
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<ReadOnlyController | null>(null);
  const themeRef = useRef(terminalTheme);
  themeRef.current = terminalTheme;
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  const onDisposeRef = useRef(options.onDispose);
  onDisposeRef.current = options.onDispose;
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

  useEffect(() => {
    applyTerminalTheme(termRef.current, terminalTheme);
  }, [terminalTheme]);

  useReadOnlyContainerFit(containerRef, sessionRef);

  return { containerRef, mountRef, instance, terminalTheme };
}
