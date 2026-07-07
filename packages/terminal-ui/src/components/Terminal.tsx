import { useQuery } from '@tanstack/react-query';
import { fetchFileRoots, fetchFileStat } from '@tmex/api-client';
import { decodePaneModes } from '@tmex/shared';
import { fileRoute } from '@tmex/stores';
import { useRuntime, useTmuxStore, useUIStore } from '@tmex/stores/react';
import { loadTerminalFonts, resolveFontStack } from '@tmex/theme';
import type { PaneSink } from '@tmex/ws-client/pane-sink-registry';
import {
  type CompatibleTerminalLike,
  FitAddon,
  type GhosttyTerminalModeSnapshot,
  TERMINAL_ENGINE,
  createTerminalController,
  writeTextToClipboard,
} from 'ghostty-terminal';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  registerCursorRectGetter,
  unregisterCursorRectGetter,
} from '../utils/keyboard-cursor-bridge';
import { SelectionToolbar } from './SelectionToolbar';
import {
  normalizeHistoryForTerminal,
  normalizeLiveOutputForTerminal,
  wrapAlternateScreenHistory,
} from './normalization';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';
import type { TerminalProps, TerminalRef } from './types';
import { useMobileTouch } from './useMobileTouch';
import { useTerminalResize } from './useTerminalResize';

const TERMINAL_SCROLLBACK = 10000;

// history 重建时恢复的终端模式：来自 gateway 随 TermHistory 下发的 tmux 权威位图
// （capture 快照本身不含 DECSET 序列，tmux 的 mouse_*_flag 是唯一可靠来源）。
// 1016/1015/9 无 tmux format 变量、pane 内程序也从未在 tmux 下拿到过这些形态，恒
// false；1007 只影响 alt 屏滚轮行为、同样无 format 变量，alt 屏按惯例开启；alt
// screen 状态本身由 history 前缀（\x1b[?1049h）恢复，这里不设。
function terminalModesFromHistory(
  modes: number,
  alternateScreen: boolean
): GhosttyTerminalModeSnapshot {
  const flags = decodePaneModes(modes);
  return {
    mouseX10: false,
    mouseNormal: flags.mouseStandard,
    mouseButton: flags.mouseButton,
    mouseAny: flags.mouseAll,
    mouseUtf8: flags.mouseUtf8,
    mouseSgr: flags.mouseSgr,
    mouseSgrPixels: false,
    mouseUrxvt: false,
    altScroll: alternateScreen,
    altScreen1047: false,
    altScreen1049: false,
  };
}

function setE2eTerminalProbe(terminal: CompatibleTerminalLike): void {
  const g = globalThis as any;
  g.__tmexE2eXterm = terminal;
  g.__tmexE2eTerminal = terminal;
  g.__tmexE2eTerminalEngine = TERMINAL_ENGINE;
  g.__tmexE2eTerminalRenderer = terminal.getRendererKind?.() ?? null;
}

function clearE2eTerminalProbe(terminal: CompatibleTerminalLike | null): void {
  if (!terminal) {
    return;
  }

  const g = globalThis as any;
  if (g.__tmexE2eTerminal !== terminal && g.__tmexE2eXterm !== terminal) {
    return;
  }

  g.__tmexE2eXterm = null;
  g.__tmexE2eTerminal = null;
  g.__tmexE2eTerminalEngine = null;
  g.__tmexE2eTerminalRenderer = null;
  g.__tmexE2eTerminalSelectionText = null;
}

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
      children,
    },
    ref
  ) => {
    const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);
    const [hasSelection, setHasSelection] = useState(false);
    const sendInput = useTmuxStore((state) => state.sendInput);
    const terminalFontId = useUIStore((state) => state.terminalFontId);
    const terminalFontSize = useUIStore((state) => state.terminalFontSize);
    const terminalLineHeight = useUIStore((state) => state.terminalLineHeight);
    const { t } = useTranslation();
    const runtime = useRuntime();

    const terminalTheme = useMemo(() => {
      switch (theme) {
        case 'light':
          return XTERM_THEME_LIGHT;
        default:
          return XTERM_THEME_DARK;
      }
    }, [theme]);

    const containerRef = useRef<HTMLDivElement>(null);
    const mountRef = useRef<HTMLDivElement>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const currentDeviceIdRef = useRef(deviceId);
    const currentPaneIdRef = useRef(paneId);
    const canWriteRef = useRef(deviceConnected && !isSelectionInvalid);
    const currentInputModeRef = useRef(inputMode);
    const currentTerminalThemeRef = useRef(terminalTheme);
    const liveOutputEndedWithCR = useRef(false);
    const lastTerminalInstanceRef = useRef<CompatibleTerminalLike | null>(null);

    const getTerminalForTouch = useCallback(() => instance, [instance]);
    useMobileTouch(containerRef, getTerminalForTouch);

    useEffect(() => {
      currentDeviceIdRef.current = deviceId;
      currentPaneIdRef.current = paneId;
    }, [deviceId, paneId]);

    useEffect(() => {
      canWriteRef.current = deviceConnected && !isSelectionInvalid;
    }, [deviceConnected, isSelectionInvalid]);

    useEffect(() => {
      currentInputModeRef.current = inputMode;
    }, [inputMode]);

    useEffect(() => {
      currentTerminalThemeRef.current = terminalTheme;
    }, [terminalTheme]);

    const sendTerminalInput = useCallback(
      (data: string) => {
        if (!data || inputMode !== 'direct') {
          return;
        }
        if (!canWriteRef.current) {
          return;
        }

        const activeDeviceId = currentDeviceIdRef.current;
        const activePaneId = currentPaneIdRef.current;
        if (!activeDeviceId || !activePaneId) {
          return;
        }

        sendInput(activeDeviceId, activePaneId, data, false);
      },
      [inputMode, sendInput]
    );

    const { pendingLocalSize, scheduleResize, runPostSelectResize, setFitAddon, setTerminal } =
      useTerminalResize({
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

    useEffect(() => {
      let cancelled = false;
      let createdTerminal: Awaited<ReturnType<typeof createTerminalController>> | null = null;

      void (async () => {
        // 先等选中字体（主字体 + 符号兜底）加载完，再创建终端：open() 内部按 fontFamily
        // 测量 cell 尺寸，字体未就绪会按 monospace 回退测宽，导致后续字形与网格错位。
        await loadTerminalFonts(terminalFontId, terminalFontSize);
        if (cancelled) {
          return;
        }

        const terminal = await createTerminalController({
          fontFamily: resolveFontStack(terminalFontId),
          fontSize: terminalFontSize,
          lineHeight: terminalLineHeight,
          scrollback: TERMINAL_SCROLLBACK,
          theme: currentTerminalThemeRef.current,
          disableStdin: currentInputModeRef.current === 'editor',
        });
        if (cancelled) {
          terminal.dispose();
          return;
        }

        createdTerminal = terminal;
        if (mountRef.current) {
          terminal.open(mountRef.current);
        }
        setInstance(terminal);
      })();

      return () => {
        cancelled = true;
        setInstance(null);
        clearE2eTerminalProbe(createdTerminal);
        createdTerminal?.dispose();
      };
      // 字体设置变更（无 post-init 改字体 API）时重建控制器：重新测度量 + 重排。
    }, [terminalFontId, terminalFontSize, terminalLineHeight]);

    // e2e 桥指向焦点实例（分屏多实例下 autoFocus 即焦点性；单 pane 恒 true）
    useEffect(() => {
      if (!instance || !autoFocus) {
        return;
      }
      setE2eTerminalProbe(instance);
    }, [instance, autoFocus]);

    useEffect(() => {
      instance?.setFocused?.(focused);
    }, [instance, focused]);

    useEffect(() => {
      if (!instance || !('setTheme' in instance)) {
        return;
      }

      (instance as any).setTheme(terminalTheme);
    }, [instance, terminalTheme]);

    useEffect(() => {
      if (!instance || !('setDisableStdin' in instance)) {
        return;
      }

      (instance as any).setDisableStdin(inputMode === 'editor');
    }, [instance, inputMode]);

    // 注册当前终端的光标矩形 getter，供 main.tsx 键盘避让（光标对齐模式）按需读取。
    // getter 内部按聚焦判定，编辑器模式/其他终端聚焦时返回 null，宿主自动回退整页上移。
    useEffect(() => {
      if (!instance?.getCursorViewportRect) {
        return;
      }
      const getter = () => instance.getCursorViewportRect?.() ?? null;
      registerCursorRectGetter(getter);
      return () => unregisterCursorRectGetter(getter);
    }, [instance]);

    // direct 模式下终端就绪（刷新、切换 pane 导致的重新挂载）或从 editor 切回时，
    // 焦点应回到终端；移动端跳过，避免自动弹出软键盘
    useEffect(() => {
      if (!instance || inputMode !== 'direct' || !autoFocus) {
        return;
      }
      const isMobileLike = window.innerWidth < 768 || 'ontouchstart' in window;
      if (isMobileLike) {
        return;
      }
      instance.focus();
    }, [instance, inputMode, autoFocus]);

    const paneSink: PaneSink | null = useMemo(() => {
      if (!instance) {
        return null;
      }

      return {
        onReset: (origin) => {
          instance.reset();
          liveOutputEndedWithCR.current = false;
          // history-refresh（远端 resize 后的内容重建）不上报本地尺寸，
          // 避免不同视口的客户端互相抢 window 尺寸
          if (origin !== 'history-refresh') {
            runPostSelectResize();
          }
        },
        onApplyHistory: (data, alternateScreen, modes) => {
          instance.restoreModeSnapshot?.(terminalModesFromHistory(modes, alternateScreen));
          const payload = alternateScreen
            ? wrapAlternateScreenHistory(data)
            : normalizeHistoryForTerminal(data);
          instance.write(payload);
          instance.forceFullRepaint?.();
        },
        onOutput: (data) => {
          const normalized = normalizeLiveOutputForTerminal(data, liveOutputEndedWithCR.current);
          liveOutputEndedWithCR.current = normalized.endedWithCR;
          instance.write(normalized.normalized);
        },
      };
    }, [instance, runPostSelectResize]);

    useEffect(() => {
      if (!instance) {
        lastTerminalInstanceRef.current = null;
      } else if (lastTerminalInstanceRef.current !== instance) {
        liveOutputEndedWithCR.current = false;
        lastTerminalInstanceRef.current = instance;
      }
    }, [instance]);

    useEffect(() => {
      if (!paneSink || !deviceId || !paneId) {
        return;
      }
      return runtime.paneSinks.registerPaneSink(deviceId, paneId, paneSink);
    }, [paneSink, deviceId, paneId, runtime]);

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

    useEffect(() => {
      if (!instance || !deviceId || !paneId) return;

      const disposable = instance.onData((data) => {
        if (!deviceConnected || isSelectionInvalid) return;
        sendTerminalInput(data);
      });

      instance.attachCustomKeyEventHandler((domEvent) => {
        if (!deviceConnected || isSelectionInvalid) return true;
        if (domEvent.type !== 'keydown') return true;
        if (inputMode !== 'direct') return true;

        if (domEvent.shiftKey && domEvent.key === 'Enter') {
          domEvent.preventDefault();
          sendTerminalInput('\x1b[13;2u');
          return false;
        }

        return true;
      });

      return () => {
        disposable.dispose();
        instance.attachCustomKeyEventHandler(() => true);
      };
    }, [
      instance,
      deviceConnected,
      isSelectionInvalid,
      inputMode,
      sendTerminalInput,
      deviceId,
      paneId,
    ]);

    // 终端内链接（Mac Cmd+Click / 其它 Ctrl+Click）在新标签页打开；与连接状态无关。
    useEffect(() => {
      if (!instance?.onLinkActivated) return;
      const disposable = instance.onLinkActivated((url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      });
      return () => disposable.dispose();
    }, [instance]);

    // 文件链接上下文：该设备已启用的授权根 + 当前 pane 的 cwd，注入终端做候选有效性过滤。
    const { data: fileRootsData } = useQuery({
      queryKey: ['files', 'roots'],
      queryFn: () => fetchFileRoots(runtime.apiClient),
      staleTime: 30_000,
    });
    const fileLinkRoots = useMemo(
      () =>
        (fileRootsData?.roots ?? []).filter((root) => root.enabled && root.deviceId === deviceId),
      [fileRootsData, deviceId]
    );
    const paneCurrentPath = useTmuxStore((state) => {
      const session = state.snapshots[deviceId]?.session;
      if (!session) return undefined;
      for (const win of session.windows) {
        for (const pane of win.panes) {
          if (pane.id === paneId) return pane.currentPath;
        }
      }
      return undefined;
    });

    useEffect(() => {
      instance?.setFileLinkContext?.({
        cwd: paneCurrentPath ?? null,
        rootPaths: fileLinkRoots.map((root) => root.path),
      });
    }, [instance, paneCurrentPath, fileLinkRoots]);

    // 文件链接点击：最长前缀匹配定位 root，stat 校验存在后跳转文件预览。
    useEffect(() => {
      if (!instance?.onFileLinkActivated) return;
      const disposable = instance.onFileLinkActivated((path) => {
        const root = fileLinkRoots
          .filter((r) => path === r.path || path.startsWith(r.path === '/' ? '/' : `${r.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!root) return;
        void fetchFileStat(root.id, path, runtime.apiClient)
          .then(() => {
            if (onOpenFile) {
              onOpenFile(root.id, path);
            } else {
              runtime.host.navigate(fileRoute(root.id, path));
            }
          })
          .catch(() => {
            runtime.notifications.error(t('terminal.fileLinkNotFound'));
          });
      });
      return () => disposable.dispose();
    }, [instance, fileLinkRoots, onOpenFile, runtime, t]);

    useEffect(() => {
      if (!instance?.onSelectionChange) {
        setHasSelection(false);
        return;
      }

      const disposable = instance.onSelectionChange((text) => {
        setHasSelection(Boolean(text));
      });

      return () => {
        disposable.dispose();
        setHasSelection(false);
      };
    }, [instance]);

    const handleCopySelection = useCallback(() => {
      if (!instance) return;
      const text = instance.getSelection?.() ?? '';
      if (!text) return;

      void writeTextToClipboard(text)
        .then(() => {
          runtime.notifications.success(t('terminal.copied'));
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.copyFailed'));
        })
        .finally(() => {
          instance.clearSelection?.();
          instance.focus();
        });
    }, [instance, runtime, t]);

    const handlePasteClipboard = useCallback(() => {
      if (!instance) return;

      const read = navigator.clipboard?.readText
        ? navigator.clipboard.readText()
        : Promise.reject<string>(new Error('clipboard unavailable'));
      void read
        .then((text) => {
          if (text) {
            instance.paste(text);
          }
          instance.clearSelection?.();
          instance.focus();
        })
        .catch(() => {
          runtime.notifications.error(t('terminal.pasteFailed'));
        });
    }, [instance, runtime, t]);

    const handleDismissSelection = useCallback(() => {
      instance?.clearSelection?.();
      instance?.focus();
    }, [instance]);

    useImperativeHandle(
      ref,
      () => ({
        write: (data) => instance?.write(data),
        reset: () => {
          instance?.reset();
          liveOutputEndedWithCR.current = false;
        },
        scrollToBottom: () => instance?.scrollToBottom(),
        resize: (cols, rows) => instance?.resize(cols, rows),
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
          if (rect.width === 0 || rect.height === 0) return null;

          const core = term._core;
          let cols: number;
          if (fitAddon) {
            try {
              const dims = fitAddon.proposeDimensions();
              if (dims) {
                cols = Math.max(2, dims.cols);
              } else {
                const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
                cols = Math.max(2, Math.floor(rect.width / cellWidth));
              }
            } catch {
              const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
              cols = Math.max(2, Math.floor(rect.width / cellWidth));
            }
          } else {
            const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 9;
            cols = Math.max(2, Math.floor(rect.width / cellWidth));
          }

          const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
          const rows = Math.max(2, Math.floor(rect.height / cellHeight));

          return { cols, rows };
        },
        getPendingLocalSize: () => pendingLocalSize.current,
        getCellSize: () => {
          const core = instance?._core;
          const cell = core?._renderService?.dimensions?.css?.cell;
          if (!cell?.width || !cell?.height) return null;
          return { width: cell.width, height: cell.height };
        },
      }),
      [instance, pendingLocalSize, runPostSelectResize, scheduleResize]
    );

    return (
      <div
        className="flex h-full w-full flex-col"
        style={{ backgroundColor: terminalTheme.background }}
        data-terminal-engine={TERMINAL_ENGINE}
      >
        <div ref={containerRef} className="relative min-h-0 w-full flex-1">
          <div ref={mountRef} className="absolute inset-0" />
          <SelectionToolbar
            visible={hasSelection}
            canPaste={inputMode === 'direct' && deviceConnected && !isSelectionInvalid}
            onCopy={handleCopySelection}
            onPaste={handlePasteClipboard}
            onDismiss={handleDismissSelection}
          />
        </div>
        {children}
      </div>
    );
  }
);

Terminal.displayName = 'Terminal';
