import { useRuntime, useUIStore } from '@tmex/stores/react';
import { loadTerminalFonts, resolveFontStack } from '@tmex/theme';
import {
  type CompatibleTerminalLike,
  TERMINAL_ENGINE,
  createTerminalController,
} from 'ghostty-terminal';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { TerminalSurface } from '../TerminalSurface';
import {
  type TerminalDiagnosticStage,
  reportTerminalDiagnostic,
  scheduleTerminalDiagnosticSamples,
  useTerminalDiagnosticsReporter,
} from '../terminal-diagnostics';
import {
  type TerminalController,
  type TerminalRenderTarget,
  writeCanonicalSnapshot,
  writeLiveOutput,
} from '../terminal-snapshot';
import { terminalStreamDiagnostic } from '../terminalBootDiagnostics';
import type { XTERM_THEME_DARK } from '../theme';
import type { TerminalProps } from '../types';
import { useLatestRef } from './useLatestRef';

const TERMINAL_SCROLLBACK = 10000;

export type TerminalBootState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

export interface UseTerminalBootSurfaceOptions {
  deviceId: string;
  paneId: string;
  inputMode: TerminalProps['inputMode'];
  sizingMode: 'report' | 'follow';
  autoFocus: boolean;
  terminalTheme: typeof XTERM_THEME_DARK;
  prepareResources: TerminalProps['prepareResources'];
  runPostSelectResize: () => void;
}

export interface TerminalBootSurface {
  instance: CompatibleTerminalLike | null;
  bootState: TerminalBootState;
  retry: () => void;
  /** 各代终端 mount 节点的宿主容器 */
  generationHostRef: RefObject<HTMLDivElement | null>;
  surfaceRef: RefObject<TerminalSurface<TerminalRenderTarget> | null>;
  /** 最后一次由外部（分屏按 tmux layout）显式下发的权威尺寸 */
  authoritativeSizeRef: RefObject<{ cols: number; rows: number } | null>;
}

interface TerminalE2eGlobals {
  __tmexE2eXterm: CompatibleTerminalLike | null;
  __tmexE2eTerminal: CompatibleTerminalLike | null;
  __tmexE2eTerminalEngine: typeof TERMINAL_ENGINE | null;
  __tmexE2eTerminalRenderer: string | null;
  __tmexE2eTerminalSelectionText: string | null;
}

function terminalE2eGlobals(): TerminalE2eGlobals {
  return globalThis as unknown as TerminalE2eGlobals;
}

function setE2eTerminalProbe(terminal: CompatibleTerminalLike): void {
  const g = terminalE2eGlobals();
  g.__tmexE2eXterm = terminal;
  g.__tmexE2eTerminal = terminal;
  g.__tmexE2eTerminalEngine = TERMINAL_ENGINE;
  g.__tmexE2eTerminalRenderer = terminal.getRendererKind?.() ?? null;
}

function clearE2eTerminalProbe(terminal: CompatibleTerminalLike | null): void {
  if (!terminal) {
    return;
  }

  const g = terminalE2eGlobals();
  if (g.__tmexE2eTerminal !== terminal && g.__tmexE2eXterm !== terminal) {
    return;
  }

  g.__tmexE2eXterm = null;
  g.__tmexE2eTerminal = null;
  g.__tmexE2eTerminalEngine = null;
  g.__tmexE2eTerminalRenderer = null;
  g.__tmexE2eTerminalSelectionText = null;
}

/**
 * 终端资源面：字体/控制器的加载、TerminalSurface 各代的建立与释放，以及首屏诊断上报。
 * 唯一持有 TerminalSurface 的地方，其余 hook 只经 surfaceRef 读当前可见 target。
 */
export function useTerminalBootSurface({
  deviceId,
  paneId,
  inputMode,
  sizingMode,
  autoFocus,
  terminalTheme,
  prepareResources,
  runPostSelectResize,
}: UseTerminalBootSurfaceOptions): TerminalBootSurface {
  const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);
  const [bootState, setBootState] = useState<TerminalBootState>({ status: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const runtime = useRuntime();
  const terminalDiagnosticsReporter = useTerminalDiagnosticsReporter();
  const terminalFontId = useUIStore((state) => state.terminalFontId);
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);

  const generationHostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<TerminalSurface<TerminalRenderTarget> | null>(null);
  // 快照必须按其自带的 rows/cols 解析才不会错行，但写完后终端就停在 capture 时的尺寸上；
  // follow 模式下 reportSize 直接 return，没有任何东西会把它改回来，于是排版一直乱到
  // 用户手动 resize。
  const authoritativeSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const currentDeviceIdRef = useLatestRef(deviceId);
  const currentPaneIdRef = useLatestRef(paneId);
  const currentInputModeRef = useLatestRef(inputMode);
  const currentTerminalThemeRef = useLatestRef(terminalTheme);
  const sizingModeRef = useLatestRef(sizingMode);
  const runPostSelectResizeRef = useLatestRef(runPostSelectResize);

  const retry = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is an explicit failed-resource retry trigger
  useEffect(() => {
    let cancelled = false;
    let stopDiagnosticSamples = () => {};
    let hasCommittedSnapshot = false;
    const fontFamily = resolveFontStack(terminalFontId);
    const streamDiagnostic = () =>
      terminalStreamDiagnostic(
        runtime.transport.sourceRoute,
        surfaceRef.current?.getDiagnosticState()
      );
    const diagnosticArgs = (
      stage: TerminalDiagnosticStage,
      terminal: CompatibleTerminalLike | null,
      mount: HTMLElement | null = mountRef.current
    ) => ({
      surface: 'terminal' as const,
      stage,
      terminal,
      mount,
      fontFamily,
      fontSize: terminalFontSize,
      stream: streamDiagnostic,
    });

    surfaceRef.current = null;
    setInstance(null);
    setBootState({ status: 'loading' });
    reportTerminalDiagnostic(terminalDiagnosticsReporter, diagnosticArgs('mount', null));

    void (async () => {
      try {
        await prepareResources?.();
        await loadTerminalFonts(terminalFontId, terminalFontSize);
      } catch (error) {
        reportTerminalDiagnostic(
          terminalDiagnosticsReporter,
          diagnosticArgs('font_load_failed', null)
        );
        if (!cancelled) {
          setBootState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Terminal resources failed to load.',
          });
        }
        return;
      }
      if (cancelled) return;
      reportTerminalDiagnostic(terminalDiagnosticsReporter, diagnosticArgs('fonts_ready', null));

      const createTarget = async (): Promise<TerminalRenderTarget> => {
        let terminal: TerminalController;
        try {
          terminal = await createTerminalController({
            fontFamily,
            fontSize: terminalFontSize,
            lineHeight: terminalLineHeight,
            scrollback: TERMINAL_SCROLLBACK,
            theme: currentTerminalThemeRef.current,
            disableStdin: currentInputModeRef.current === 'editor',
          });
        } catch (error) {
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('controller_failed', null)
          );
          throw error;
        }
        if (cancelled) {
          terminal.dispose();
          throw new Error('terminal initialization cancelled');
        }

        const host = generationHostRef.current;
        if (!host) {
          terminal.dispose();
          throw new Error('Terminal mount is unavailable.');
        }
        const mount = document.createElement('div');
        mount.className = 'absolute inset-0';
        mount.style.visibility = 'hidden';
        mount.style.pointerEvents = 'none';
        host.appendChild(mount);
        reportTerminalDiagnostic(
          terminalDiagnosticsReporter,
          diagnosticArgs('controller_ready', terminal, mount)
        );
        try {
          terminal.open(mount);
        } catch (error) {
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('open_failed', terminal, mount)
          );
          terminal.dispose();
          mount.remove();
          throw error;
        }
        reportTerminalDiagnostic(
          terminalDiagnosticsReporter,
          diagnosticArgs('opened', terminal, mount)
        );
        return {
          terminal,
          mount,
          liveOutputEndedWithCR: false,
          dispose() {
            clearE2eTerminalProbe(terminal);
            terminal.dispose();
            mount.remove();
          },
        };
      };

      const manager = new TerminalSurface<TerminalRenderTarget>({
        createTarget,
        writeSnapshot: writeCanonicalSnapshot,
        writeLive: writeLiveOutput,
        activate(target) {
          target.mount.style.visibility = 'visible';
          target.mount.style.pointerEvents = 'auto';
          target.terminal.scrollToBottom();
          target.terminal.forceFullRepaint?.();
        },
        onRecoveryRequired(reason) {
          if (cancelled) return;
          const visible = surfaceRef.current?.getVisibleTarget();
          reportTerminalDiagnostic(
            terminalDiagnosticsReporter,
            diagnosticArgs('recovery_started', visible?.terminal ?? null, visible?.mount ?? null)
          );
          if (!hasCommittedSnapshot && runtime.transport.capabilities.atomicScreen) {
            setBootState(
              reason === 'resource_exhausted'
                ? {
                    status: 'error',
                    message: 'Terminal rendering failed before the first screen was ready.',
                  }
                : { status: 'loading' }
            );
          }
          const activeDeviceId = currentDeviceIdRef.current;
          const activePaneId = currentPaneIdRef.current;
          if (activeDeviceId && activePaneId) {
            runtime.stores.tmux.getState().requestPaneScreen(activeDeviceId, activePaneId);
          }
        },
        onSnapshotApplied(target, snapshot) {
          if (cancelled) return;
          mountRef.current = target.mount;
          setInstance(target.terminal);
          if (snapshot) hasCommittedSnapshot = true;
          // 快照按自带尺寸解析完毕，收敛回 tmux 权威尺寸；此后由 live 流继续。
          if (snapshot) {
            const authoritative = authoritativeSizeRef.current;
            if (sizingModeRef.current === 'follow') {
              if (
                authoritative &&
                (target.terminal.cols !== authoritative.cols ||
                  target.terminal.rows !== authoritative.rows)
              ) {
                target.terminal.resize(authoritative.cols, authoritative.rows);
                target.terminal.forceFullRepaint?.();
              }
            } else {
              runPostSelectResizeRef.current();
            }
          }
          if (snapshot) {
            reportTerminalDiagnostic(
              terminalDiagnosticsReporter,
              diagnosticArgs('generation_activated', target.terminal, target.mount)
            );
          }
          setBootState(
            runtime.transport.capabilities.atomicScreen && !snapshot
              ? { status: 'loading' }
              : { status: 'ready' }
          );
          stopDiagnosticSamples();
          stopDiagnosticSamples = scheduleTerminalDiagnosticSamples(terminalDiagnosticsReporter, {
            surface: 'terminal',
            terminal: target.terminal,
            mount: target.mount,
            fontFamily,
            fontSize: terminalFontSize,
            stream: streamDiagnostic,
          });
        },
      });
      surfaceRef.current = manager;
      try {
        await manager.initialize();
      } catch (error) {
        if (!cancelled) {
          setBootState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Terminal failed to initialize.',
          });
        }
        return;
      }
    })();

    return () => {
      cancelled = true;
      stopDiagnosticSamples();
      const manager = surfaceRef.current;
      if (manager) manager.dispose();
      if (surfaceRef.current === manager) surfaceRef.current = null;
      mountRef.current = null;
      setInstance(null);
    };
  }, [
    prepareResources,
    retryNonce,
    runtime,
    terminalDiagnosticsReporter,
    terminalFontId,
    terminalFontSize,
    terminalLineHeight,
  ]);

  // e2e 桥指向焦点实例（分屏多实例下 autoFocus 即焦点性；单 pane 恒 true）
  useEffect(() => {
    if (!instance || !autoFocus) {
      return;
    }
    setE2eTerminalProbe(instance);
  }, [instance, autoFocus]);

  useEffect(() => {
    instance?.setTheme?.(terminalTheme);
  }, [instance, terminalTheme]);

  return {
    instance,
    bootState,
    retry,
    generationHostRef,
    surfaceRef,
    authoritativeSizeRef,
  };
}
