import { FitAddon, TERMINAL_ENGINE } from 'ghostty-terminal';
import { Loader2 } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectionToolbar } from './SelectionToolbar';
import { usePaneSinkRegistration } from './hooks/usePaneSinkRegistration';
import { useTerminalBootSurface } from './hooks/useTerminalBootSurface';
import { useTerminalClipboard } from './hooks/useTerminalClipboard';
import { useTerminalFileLinks } from './hooks/useTerminalFileLinks';
import { useTerminalInput } from './hooks/useTerminalInput';
import { computeContainerSize } from './terminalMetrics';
import { resolveTerminalThemeProp } from './theme';
import type { TerminalProps, TerminalRef } from './types';
import { useMobileTouch } from './useMobileTouch';
import { useTerminalResize } from './useTerminalResize';

export const Terminal = forwardRef<TerminalRef, TerminalProps>(
  (
    {
      deviceId,
      paneId,
      theme,
      inputMode,
      deviceConnected,
      isSelectionInvalid,
      sizingMode = 'report',
      autoFocus = true,
      focused = true,
      onResize,
      onSync,
      onResizeSettled,
      onOpenFile,
      prepareResources,
      children,
    },
    ref
  ) => {
    const { t } = useTranslation();

    const terminalTheme = useMemo(() => resolveTerminalThemeProp(theme), [theme]);

    const containerRef = useRef<HTMLDivElement>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);

    const {
      pendingLocalSize,
      scheduleResize,
      runPostSelectResize,
      setFitAddon,
      setTerminal,
      clearPendingLocalSize,
    } = useTerminalResize({
      deviceId,
      paneId,
      deviceConnected,
      isSelectionInvalid,
      sizingMode,
      onResize,
      onSync,
      onResizeSettled,
      getContainerRect: () => {
        const el = containerRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      },
    });

    const { instance, bootState, retry, generationHostRef, surfaceRef, authoritativeSizeRef } =
      useTerminalBootSurface({
        deviceId,
        paneId,
        inputMode,
        sizingMode,
        autoFocus,
        terminalTheme,
        prepareResources,
        runPostSelectResize,
      });

    const getTerminalForTouch = useCallback(() => instance, [instance]);
    useMobileTouch(containerRef, getTerminalForTouch);

    useTerminalInput({
      deviceId,
      paneId,
      instance,
      inputMode,
      deviceConnected,
      isSelectionInvalid,
      autoFocus,
      focused,
    });

    usePaneSinkRegistration({
      deviceId,
      paneId,
      instance,
      surfaceRef,
      containerRef,
      runPostSelectResize,
    });

    useEffect(() => {
      if (!instance) {
        fitAddonRef.current = null;
        setFitAddon(null);
        setTerminal(null);
        return;
      }

      const fitAddon = new FitAddon();
      instance.loadAddon(fitAddon);
      fitAddonRef.current = fitAddon;
      setFitAddon(fitAddon);
      setTerminal(instance);

      runPostSelectResize();

      return () => {
        try {
          fitAddon.dispose();
        } finally {
          fitAddonRef.current = null;
          setFitAddon(null);
          setTerminal(null);
        }
      };
    }, [instance, runPostSelectResize, setFitAddon, setTerminal]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      let rafId: number | null = null;
      const ro = new ResizeObserver(() => {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
        rafId = requestAnimationFrame(() => {
          rafId = null;
          scheduleResize('resize');
        });
      });
      ro.observe(el);
      return () => {
        ro.disconnect();
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [scheduleResize]);

    useTerminalFileLinks({ deviceId, paneId, instance, onOpenFile });

    const { hasSelection, copySelection, pasteClipboard, dismissSelection } = useTerminalClipboard({
      instance,
    });

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => instance?.write(data),
        reset: () => {
          instance?.reset();
          const target = surfaceRef.current?.getVisibleTarget();
          if (target) target.liveOutputEndedWithCR = false;
        },
        scrollToBottom: () => instance?.scrollToBottom(),
        resize: (cols, rows) => {
          authoritativeSizeRef.current = { cols, rows };
          instance?.resize(cols, rows);
        },
        getTerminal: () => instance ?? null,
        getSize: () => {
          if (!instance) return null;
          return { cols: Math.max(2, instance.cols), rows: Math.max(2, instance.rows) };
        },
        runPostSelectResize: () => runPostSelectResize(),
        scheduleResize: (kind, options) => scheduleResize(kind, options),
        calculateSizeFromContainer: () => {
          const container = containerRef.current;
          const term = instance;
          const fitAddon = fitAddonRef.current;
          if (!container || !term) return null;

          const rect = container.getBoundingClientRect();
          return computeContainerSize({
            rect: { width: rect.width, height: rect.height },
            cell: term._core?._renderService?.dimensions?.css?.cell,
            proposeDimensions: fitAddon ? () => fitAddon.proposeDimensions() : null,
          });
        },
        getPendingLocalSize: () => pendingLocalSize.current,
        clearPendingLocalSize,
        getCellSize: () => {
          const cell = instance?._core?._renderService?.dimensions?.css?.cell;
          if (!cell?.width || !cell?.height) return null;
          return { width: cell.width, height: cell.height };
        },
      }),
      [
        authoritativeSizeRef,
        clearPendingLocalSize,
        instance,
        pendingLocalSize,
        runPostSelectResize,
        scheduleResize,
        surfaceRef,
      ]
    );

    return (
      <div
        className="flex h-full w-full flex-col"
        style={{ backgroundColor: terminalTheme.background }}
        data-terminal-engine={TERMINAL_ENGINE}
      >
        <div ref={containerRef} className="relative min-h-0 w-full flex-1">
          <div
            ref={generationHostRef}
            className={`absolute inset-0 ${bootState.status === 'ready' ? '' : 'invisible'}`}
          />
          {bootState.status !== 'ready' && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center p-8 text-center"
              role={bootState.status === 'error' ? 'alert' : 'status'}
              aria-live="polite"
              data-testid="terminal-boot-placeholder"
            >
              <div className="max-w-sm space-y-4">
                {bootState.status === 'loading' && (
                  <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                )}
                <h3 className="text-lg font-medium">
                  {bootState.status === 'loading' ? t('common.loading') : bootState.message}
                </h3>
                {bootState.status === 'error' && (
                  <button
                    type="button"
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
                    onClick={retry}
                  >
                    Retry terminal
                  </button>
                )}
              </div>
            </div>
          )}
          <SelectionToolbar
            visible={hasSelection}
            canPaste={inputMode === 'direct' && deviceConnected && !isSelectionInvalid}
            onCopy={copySelection}
            onPaste={pasteClipboard}
            onDismiss={dismissSelection}
          />
        </div>
        {children}
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
