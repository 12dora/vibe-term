import type { GatewayRebaseReason, GatewayTransportSourceRoute } from '@tmex/ws-client';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import { type ReactNode, createContext, useContext } from 'react';

export type TerminalDiagnosticSurface = 'terminal' | 'preview';

export type TerminalDiagnosticStage =
  | 'mount'
  | 'fonts_ready'
  | 'controller_ready'
  | 'opened'
  | 'content_written'
  | 'sample_500ms'
  | 'sample_2500ms'
  | 'sample_8000ms'
  | 'font_load_failed'
  | 'controller_failed'
  | 'open_failed'
  | 'content_write_failed'
  | 'recovery_started'
  | 'generation_activated';

export type TerminalDiagnosticRenderer = 'none' | 'canvas' | 'unknown';
export type TerminalDiagnosticFontStatus = 'unsupported' | 'loading' | 'loaded';

export interface TerminalStreamDiagnosticInput {
  sourceRoute: GatewayTransportSourceRoute;
  paneEpoch: Uint8Array | null;
  terminalSeq: bigint | null;
  historyEpoch: Uint8Array | null;
  historyBeforeLine: number | null;
  recoveryState: 'initializing' | 'live' | 'recovering' | 'disposed';
  recoveryReason: GatewayRebaseReason | null;
  replayBytes: number;
  replayBytesLimit: number;
  historyBytes: number;
  historyBytesLimit: number;
  historyPages: number;
  historyPagesLimit: number;
}

export interface TerminalStreamDiagnostic {
  sourceRoute: GatewayTransportSourceRoute;
  paneEpochTag: string | null;
  terminalCursor: string | null;
  historyEpochTag: string | null;
  historyBeforeLine: number | null;
  recoveryState: TerminalStreamDiagnosticInput['recoveryState'];
  recoveryReason: GatewayRebaseReason | null;
  replayBytes: number;
  replayBytesLimit: number;
  historyBytes: number;
  historyBytesLimit: number;
  historyPages: number;
  historyPagesLimit: number;
}

export interface TerminalRenderDiagnostic {
  surface: TerminalDiagnosticSurface;
  stage: TerminalDiagnosticStage;
  controllerReady: boolean;
  renderer: TerminalDiagnosticRenderer;
  fontStatus: TerminalDiagnosticFontStatus;
  selectedFontLoaded: boolean | null;
  cols: number;
  rows: number;
  bufferLines: number;
  sampledBufferLines: number;
  nonBlankBufferLines: number;
  mountWidth: number;
  mountHeight: number;
  canvasCount: number;
  canvasCssWidth: number;
  canvasCssHeight: number;
  canvasBitmapWidth: number;
  canvasBitmapHeight: number;
  pixelsReadable: boolean;
  nonTransparentPixels: number;
  distinctColorCount: number;
  overlayPresent: boolean;
  stream: TerminalStreamDiagnostic | null;
}

export type TerminalDiagnosticReporter = (
  diagnostic: TerminalRenderDiagnostic
) => void | Promise<void>;

type CollectTerminalDiagnosticArgs = {
  surface: TerminalDiagnosticSurface;
  stage: TerminalDiagnosticStage;
  terminal: CompatibleTerminalLike | null;
  mount: HTMLElement | null;
  fontFamily: string;
  fontSize: number;
  document?: Document;
  stream?: TerminalStreamDiagnosticInput | (() => TerminalStreamDiagnosticInput | null) | null;
};

const BUFFER_SAMPLE_LIMIT = 512;
const PIXEL_SAMPLE_WIDTH = 32;
const PIXEL_SAMPLE_HEIGHT = 16;
const TerminalDiagnosticsContext = createContext<TerminalDiagnosticReporter | null>(null);

function boundedMetric(value: number, max = 1_000_000): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), max);
}

function shortBytesHash(value: Uint8Array | null): string | null {
  if (!value) return null;
  let hash = 0x811c9dc5;
  for (const byte of value) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function sanitizeTerminalStreamDiagnostic(
  input: TerminalStreamDiagnosticInput | null
): TerminalStreamDiagnostic | null {
  if (!input) return null;
  return {
    sourceRoute: input.sourceRoute,
    paneEpochTag: shortBytesHash(input.paneEpoch),
    terminalCursor:
      input.terminalSeq !== null && input.terminalSeq >= 0n ? input.terminalSeq.toString() : null,
    historyEpochTag: shortBytesHash(input.historyEpoch),
    historyBeforeLine:
      input.historyBeforeLine === null ? null : boundedMetric(input.historyBeforeLine),
    recoveryState: input.recoveryState,
    recoveryReason: input.recoveryReason,
    replayBytes: boundedMetric(input.replayBytes, Number.MAX_SAFE_INTEGER),
    replayBytesLimit: boundedMetric(input.replayBytesLimit, Number.MAX_SAFE_INTEGER),
    historyBytes: boundedMetric(input.historyBytes, Number.MAX_SAFE_INTEGER),
    historyBytesLimit: boundedMetric(input.historyBytesLimit, Number.MAX_SAFE_INTEGER),
    historyPages: boundedMetric(input.historyPages),
    historyPagesLimit: boundedMetric(input.historyPagesLimit),
  };
}

function rendererOf(terminal: CompatibleTerminalLike | null): TerminalDiagnosticRenderer {
  if (!terminal) return 'none';
  try {
    return terminal.getRendererKind?.() === 'canvas' ? 'canvas' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function bufferSummary(terminal: CompatibleTerminalLike | null): {
  bufferLines: number;
  sampledBufferLines: number;
  nonBlankBufferLines: number;
} {
  const active = terminal?.buffer?.active;
  if (!active) {
    return { bufferLines: 0, sampledBufferLines: 0, nonBlankBufferLines: 0 };
  }
  const bufferLines = boundedMetric(active.length);
  const sampledBufferLines = Math.min(bufferLines, BUFFER_SAMPLE_LIMIT);
  const start = Math.max(0, bufferLines - sampledBufferLines);
  let nonBlankBufferLines = 0;
  for (let index = start; index < bufferLines; index += 1) {
    try {
      if (active.getLine(index)?.translateToString(true).trim()) {
        nonBlankBufferLines += 1;
      }
    } catch {
      // A concurrently disposed buffer is represented by the counts collected so far.
    }
  }
  return { bufferLines, sampledBufferLines, nonBlankBufferLines };
}

function fontSummary(
  doc: Document | undefined,
  fontFamily: string,
  fontSize: number
): {
  fontStatus: TerminalDiagnosticFontStatus;
  selectedFontLoaded: boolean | null;
} {
  const fonts = doc?.fonts;
  if (!fonts) {
    return { fontStatus: 'unsupported', selectedFontLoaded: null };
  }
  let selectedFontLoaded: boolean | null = null;
  try {
    selectedFontLoaded = fonts.check(`${boundedMetric(fontSize, 512)}px ${fontFamily}`);
  } catch {
    selectedFontLoaded = false;
  }
  return {
    fontStatus: fonts.status === 'loading' ? 'loading' : 'loaded',
    selectedFontLoaded,
  };
}

function pixelSummary(
  doc: Document | undefined,
  canvas: HTMLCanvasElement | undefined
): {
  pixelsReadable: boolean;
  nonTransparentPixels: number;
  distinctColorCount: number;
} {
  if (!doc || !canvas || canvas.width <= 0 || canvas.height <= 0) {
    return { pixelsReadable: false, nonTransparentPixels: 0, distinctColorCount: 0 };
  }
  try {
    const scratch = doc.createElement('canvas');
    scratch.width = PIXEL_SAMPLE_WIDTH;
    scratch.height = PIXEL_SAMPLE_HEIGHT;
    const context = scratch.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { pixelsReadable: false, nonTransparentPixels: 0, distinctColorCount: 0 };
    }
    context.drawImage(canvas, 0, 0, PIXEL_SAMPLE_WIDTH, PIXEL_SAMPLE_HEIGHT);
    const pixels = context.getImageData(0, 0, PIXEL_SAMPLE_WIDTH, PIXEL_SAMPLE_HEIGHT).data;
    let nonTransparentPixels = 0;
    const colors = new Set<number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const alpha = pixels[offset + 3] ?? 0;
      if (alpha === 0) continue;
      nonTransparentPixels += 1;
      colors.add(
        (((pixels[offset] ?? 0) << 24) |
          ((pixels[offset + 1] ?? 0) << 16) |
          ((pixels[offset + 2] ?? 0) << 8) |
          alpha) >>>
          0
      );
    }
    return {
      pixelsReadable: true,
      nonTransparentPixels,
      distinctColorCount: colors.size,
    };
  } catch {
    return { pixelsReadable: false, nonTransparentPixels: 0, distinctColorCount: 0 };
  }
}

export function collectTerminalRenderDiagnostic(
  args: CollectTerminalDiagnosticArgs
): TerminalRenderDiagnostic {
  const doc = args.document ?? args.mount?.ownerDocument ?? globalThis.document;
  const mountRect = args.mount?.getBoundingClientRect();
  const canvases = args.mount
    ? Array.from(args.mount.querySelectorAll<HTMLCanvasElement>('canvas'))
    : [];
  const mainCanvas = canvases.find((canvas) => canvas.dataset.layer === 'main') ?? canvases[0];
  const canvasRect = mainCanvas?.getBoundingClientRect();
  const streamInput = typeof args.stream === 'function' ? args.stream() : (args.stream ?? null);
  return {
    surface: args.surface,
    stage: args.stage,
    controllerReady: args.terminal !== null,
    renderer: rendererOf(args.terminal),
    ...fontSummary(doc, args.fontFamily, args.fontSize),
    cols: boundedMetric(args.terminal?.cols ?? 0, 4096),
    rows: boundedMetric(args.terminal?.rows ?? 0, 4096),
    ...bufferSummary(args.terminal),
    mountWidth: boundedMetric(mountRect?.width ?? 0, 32_768),
    mountHeight: boundedMetric(mountRect?.height ?? 0, 32_768),
    canvasCount: boundedMetric(canvases.length, 16),
    canvasCssWidth: boundedMetric(canvasRect?.width ?? 0, 32_768),
    canvasCssHeight: boundedMetric(canvasRect?.height ?? 0, 32_768),
    canvasBitmapWidth: boundedMetric(mainCanvas?.width ?? 0, 65_536),
    canvasBitmapHeight: boundedMetric(mainCanvas?.height ?? 0, 65_536),
    ...pixelSummary(doc, mainCanvas),
    overlayPresent: Boolean(doc?.querySelector('[data-testid="terminal-status-overlay"]')),
    stream: sanitizeTerminalStreamDiagnostic(streamInput),
  };
}

export function reportTerminalDiagnostic(
  reporter: TerminalDiagnosticReporter | null,
  args: CollectTerminalDiagnosticArgs
): void {
  if (!reporter) return;
  try {
    Promise.resolve(reporter(collectTerminalRenderDiagnostic(args))).catch(() => {});
  } catch {
    // Diagnostics cannot participate in the terminal failure path.
  }
}

export function scheduleTerminalDiagnosticSamples(
  reporter: TerminalDiagnosticReporter | null,
  args: Omit<CollectTerminalDiagnosticArgs, 'stage'>
): () => void {
  if (!reporter) return () => {};
  const timers = (
    [
      [500, 'sample_500ms'],
      [2_500, 'sample_2500ms'],
      [8_000, 'sample_8000ms'],
    ] as const
  ).map(([delay, stage]) =>
    globalThis.setTimeout(() => {
      reportTerminalDiagnostic(reporter, { ...args, stage });
    }, delay)
  );
  return () => {
    for (const timer of timers) globalThis.clearTimeout(timer);
  };
}

export function TerminalDiagnosticsProvider({
  reporter,
  children,
}: {
  reporter: TerminalDiagnosticReporter;
  children: ReactNode;
}) {
  return (
    <TerminalDiagnosticsContext.Provider value={reporter}>
      {children}
    </TerminalDiagnosticsContext.Provider>
  );
}

export function useTerminalDiagnosticsReporter(): TerminalDiagnosticReporter | null {
  return useContext(TerminalDiagnosticsContext);
}
