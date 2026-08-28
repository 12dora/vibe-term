import type { TerminalThemeColors } from '@tmex/shared';
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
  type TerminalDiagnosticReporter,
  type TerminalDiagnosticStage,
  type TerminalStreamDiagnosticInput,
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
import { applyTerminalTheme } from '../theme';
import type { TerminalProps } from '../types';
import { activateRenderTarget, createTerminalRenderTarget } from './terminal-render-target';
import {
  type TerminalBootState,
  type TerminalSurfaceCreationContext,
  TerminalSurfaceLifecycle,
  type TerminalSurfaceLifecycleDeps,
} from './terminal-surface-lifecycle';
import { useLatestRef } from './useLatestRef';

const TERMINAL_SCROLLBACK = 10000;

export type { TerminalBootState } from './terminal-surface-lifecycle';

export interface UseTerminalBootSurfaceOptions {
  deviceId: string;
  paneId: string;
  inputMode: TerminalProps['inputMode'];
  sizingMode: 'report' | 'follow';
  autoFocus: boolean;
  terminalTheme: TerminalThemeColors;
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

interface BootRefs {
  generationHost: RefObject<HTMLDivElement | null>;
  surface: RefObject<TerminalSurface<TerminalRenderTarget> | null>;
  authoritativeSize: RefObject<{ cols: number; rows: number } | null>;
  sizingMode: RefObject<'report' | 'follow'>;
  runPostSelectResize: RefObject<() => void>;
  deviceId: RefObject<string>;
  paneId: RefObject<string>;
  inputMode: RefObject<TerminalProps['inputMode']>;
  terminalTheme: RefObject<TerminalThemeColors>;
}

interface BootContext {
  runtime: ReturnType<typeof useRuntime>;
  reporter: TerminalDiagnosticReporter | null;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  prepareResources: TerminalProps['prepareResources'];
  fontId: string;
  refs: BootRefs;
  setInstance(terminal: CompatibleTerminalLike | null): void;
  setBootState(state: TerminalBootState): void;
}

type StreamDiagnostic = () => TerminalStreamDiagnosticInput;

type StageReporter = (
  stage: TerminalDiagnosticStage,
  terminal: CompatibleTerminalLike | null,
  mount: HTMLElement | null
) => void;

function diagnosticStream(ctx: BootContext): StreamDiagnostic {
  return () =>
    terminalStreamDiagnostic(
      ctx.runtime.transport.sourceRoute,
      ctx.refs.surface.current?.getDiagnosticState()
    );
}

function createStageReporter(ctx: BootContext, stream: StreamDiagnostic): StageReporter {
  return (stage, terminal, mount) => {
    reportTerminalDiagnostic(ctx.reporter, {
      surface: 'terminal',
      stage,
      terminal,
      mount,
      fontFamily: ctx.fontFamily,
      fontSize: ctx.fontSize,
      stream,
    });
  };
}

function buildRenderTarget(
  ctx: BootContext,
  report: StageReporter,
  isCancelled: () => boolean
): Promise<TerminalRenderTarget> {
  return createTerminalRenderTarget<HTMLDivElement, TerminalController>({
    document,
    isCancelled,
    resolveHost: () => ctx.refs.generationHost.current,
    reportStage: report,
    onDisposed: clearE2eTerminalProbe,
    createController: () =>
      createTerminalController({
        fontFamily: ctx.fontFamily,
        fontSize: ctx.fontSize,
        lineHeight: ctx.lineHeight,
        scrollback: TERMINAL_SCROLLBACK,
        theme: ctx.refs.terminalTheme.current,
        disableStdin: ctx.refs.inputMode.current === 'editor',
      }),
  });
}

function buildSurface(
  ctx: BootContext,
  report: StageReporter,
  context: TerminalSurfaceCreationContext<TerminalRenderTarget>
): TerminalSurface<TerminalRenderTarget> {
  return new TerminalSurface<TerminalRenderTarget>({
    createTarget: () => buildRenderTarget(ctx, report, context.isCancelled),
    writeSnapshot: writeCanonicalSnapshot,
    writeLive: writeLiveOutput,
    activate: activateRenderTarget,
    onRecoveryRequired: context.onRecoveryRequired,
    onSnapshotApplied: context.onSnapshotApplied,
  });
}

// 快照必须按其自带的 rows/cols 解析才不会错行，但写完后终端就停在 capture 时的尺寸上；
// follow 模式下 reportSize 直接 return，没有任何东西会把它改回来，于是排版一直乱到
// 用户手动 resize。
function convergeSnapshotSize(ctx: BootContext, target: TerminalRenderTarget): void {
  if (ctx.refs.sizingMode.current !== 'follow') {
    ctx.refs.runPostSelectResize.current();
    return;
  }
  const authoritative = ctx.refs.authoritativeSize.current;
  if (!authoritative) return;
  if (target.terminal.cols === authoritative.cols && target.terminal.rows === authoritative.rows) {
    return;
  }
  target.terminal.resize(authoritative.cols, authoritative.rows);
  target.terminal.forceFullRepaint?.();
}

function requestPaneScreen(ctx: BootContext): void {
  const deviceId = ctx.refs.deviceId.current;
  const paneId = ctx.refs.paneId.current;
  if (!deviceId || !paneId) return;
  ctx.runtime.stores.tmux.getState().requestPaneScreen(deviceId, paneId);
}

function createLifecycleDeps(
  ctx: BootContext
): TerminalSurfaceLifecycleDeps<TerminalRenderTarget, TerminalSurface<TerminalRenderTarget>> {
  const stream = diagnosticStream(ctx);
  const report = createStageReporter(ctx, stream);
  return {
    loadResources: async () => {
      await ctx.prepareResources?.();
      await loadTerminalFonts(ctx.fontId, ctx.fontSize);
    },
    createSurface: (context) => buildSurface(ctx, report, context),
    getSurface: () => ctx.refs.surface.current,
    setSurface: (surface) => {
      ctx.refs.surface.current = surface;
    },
    bindTarget: (target) => ctx.setInstance(target?.terminal ?? null),
    setBootState: ctx.setBootState,
    reportStage: (stage, target) => report(stage, target?.terminal ?? null, target?.mount ?? null),
    startDiagnosticSamples: (target) =>
      scheduleTerminalDiagnosticSamples(ctx.reporter, {
        surface: 'terminal',
        terminal: target.terminal,
        mount: target.mount,
        fontFamily: ctx.fontFamily,
        fontSize: ctx.fontSize,
        stream,
      }),
    supportsAtomicScreen: () => ctx.runtime.transport.capabilities.atomicScreen,
    requestPaneScreen: () => requestPaneScreen(ctx),
    onSnapshotCommitted: (target) => convergeSnapshotSize(ctx, target),
  };
}

/** 异步回调只经 ref 读最新的 props；容器本身恒定，可以直接进 effect 依赖 */
function useBootRefs(options: UseTerminalBootSurfaceOptions): BootRefs {
  const created: BootRefs = {
    generationHost: useRef<HTMLDivElement | null>(null),
    surface: useRef<TerminalSurface<TerminalRenderTarget> | null>(null),
    authoritativeSize: useRef<{ cols: number; rows: number } | null>(null),
    sizingMode: useLatestRef(options.sizingMode),
    runPostSelectResize: useLatestRef(options.runPostSelectResize),
    deviceId: useLatestRef(options.deviceId),
    paneId: useLatestRef(options.paneId),
    inputMode: useLatestRef(options.inputMode),
    terminalTheme: useLatestRef(options.terminalTheme),
  };
  return useRef(created).current;
}

/**
 * 终端资源面：字体/控制器的加载、TerminalSurface 各代的建立与释放，以及首屏诊断上报。
 * 唯一持有 TerminalSurface 的地方，其余 hook 只经 surfaceRef 读当前可见 target。
 */
export function useTerminalBootSurface(
  options: UseTerminalBootSurfaceOptions
): TerminalBootSurface {
  const { autoFocus, prepareResources, terminalTheme } = options;
  const [instance, setInstance] = useState<CompatibleTerminalLike | null>(null);
  const [bootState, setBootState] = useState<TerminalBootState>({ status: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const runtime = useRuntime();
  const reporter = useTerminalDiagnosticsReporter();
  const fontId = useUIStore((state) => state.terminalFontId);
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const refs = useBootRefs(options);

  const retry = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is an explicit failed-resource retry trigger
  useEffect(() => {
    const lifecycle = new TerminalSurfaceLifecycle<
      TerminalRenderTarget,
      TerminalSurface<TerminalRenderTarget>
    >(
      createLifecycleDeps({
        runtime,
        reporter,
        fontFamily: resolveFontStack(fontId),
        fontSize,
        lineHeight,
        fontId,
        prepareResources,
        refs,
        setInstance,
        setBootState,
      })
    );
    void lifecycle.boot();
    return () => lifecycle.cancel();
  }, [fontId, fontSize, lineHeight, prepareResources, refs, reporter, retryNonce, runtime]);

  // e2e 桥指向焦点实例（分屏多实例下 autoFocus 即焦点性；单 pane 恒 true）
  useEffect(() => {
    if (!instance || !autoFocus) {
      return;
    }
    setE2eTerminalProbe(instance);
  }, [instance, autoFocus]);

  // 预设切换在运行期改的是色板对象引用：命中这里给活着的实例增量下发，不重建终端
  useEffect(() => {
    applyTerminalTheme(instance, terminalTheme);
  }, [instance, terminalTheme]);

  return {
    instance,
    bootState,
    retry,
    generationHostRef: refs.generationHost,
    surfaceRef: refs.surface,
    authoritativeSizeRef: refs.authoritativeSize,
  };
}
