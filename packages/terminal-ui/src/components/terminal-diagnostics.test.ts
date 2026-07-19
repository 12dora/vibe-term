import { describe, expect, test } from 'bun:test';
import type { CompatibleTerminalLike } from 'ghostty-terminal';
import {
  collectTerminalRenderDiagnostic,
  type TerminalDiagnosticStage,
} from './terminal-diagnostics';

function rect(width: number, height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function fakeTerminal(lines: string[]): CompatibleTerminalLike {
  return {
    cols: 93,
    rows: 31,
    element: null,
    textarea: null,
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        length: lines.length,
        getLine: (index) => {
          const text = lines[index];
          return text === undefined ? null : { translateToString: () => text };
        },
      },
    },
    _core: {
      _renderService: {
        dimensions: { css: { cell: { width: 9, height: 17 } } },
      },
    },
    write: () => {},
    reset: () => {},
    resize: () => {},
    scrollLines: () => {},
    scrollToTop: () => {},
    scrollToBottom: () => {},
    paste: () => {},
    focus: () => {},
    onData: () => ({ dispose: () => {} }),
    attachCustomKeyEventHandler: () => {},
    loadAddon: () => {},
    getRendererKind: () => 'canvas',
  };
}

function fakeMount(options?: { pixelsReadable?: boolean }) {
  const pixelsReadable = options?.pixelsReadable ?? true;
  const data = new Uint8ClampedArray(32 * 16 * 4);
  for (let index = 0; index < 32 * 16; index += 1) {
    data[index * 4] = index % 3 === 0 ? 220 : 18;
    data[index * 4 + 1] = 18;
    data[index * 4 + 2] = 18;
    data[index * 4 + 3] = 255;
  }
  const scratchContext = {
    drawImage: () => {
      if (!pixelsReadable) throw new Error('unreadable');
    },
    getImageData: () => ({ data }),
  };
  const canvas = {
    width: 1600,
    height: 640,
    dataset: { layer: 'main' },
    getBoundingClientRect: () => rect(800, 320),
  };
  const documentLike = {
    fonts: {
      status: 'loaded',
      check: () => true,
    },
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => scratchContext,
    }),
    querySelector: () => null,
  };
  const mount = {
    ownerDocument: documentLike,
    getBoundingClientRect: () => rect(800, 320),
    querySelectorAll: () => [canvas],
  };
  return { mount, documentLike };
}

describe('terminal render diagnostics', () => {
  test('reports counts and a pixel summary without returning terminal content', () => {
    const { mount, documentLike } = fakeMount();
    const diagnostic = collectTerminalRenderDiagnostic({
      surface: 'terminal',
      stage: 'sample_2500ms',
      terminal: fakeTerminal(['secret command', '', 'secret output']),
      mount: mount as unknown as HTMLElement,
      fontFamily: 'SecretFont, monospace',
      fontSize: 13,
      document: documentLike as unknown as Document,
    });

    expect(diagnostic).toMatchObject({
      surface: 'terminal',
      stage: 'sample_2500ms',
      controllerReady: true,
      renderer: 'canvas',
      fontStatus: 'loaded',
      selectedFontLoaded: true,
      cols: 93,
      rows: 31,
      bufferLines: 3,
      sampledBufferLines: 3,
      nonBlankBufferLines: 2,
      mountWidth: 800,
      mountHeight: 320,
      canvasCount: 1,
      canvasBitmapWidth: 1600,
      canvasBitmapHeight: 640,
      pixelsReadable: true,
      nonTransparentPixels: 512,
      distinctColorCount: 2,
      overlayPresent: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
    expect(JSON.stringify(diagnostic)).not.toContain('SecretFont');
  });

  test('bounds buffer work and safely degrades when Canvas pixels cannot be read', () => {
    const { mount, documentLike } = fakeMount({ pixelsReadable: false });
    const lines = Array.from({ length: 800 }, (_, index) => (index === 799 ? 'latest' : ''));
    const diagnostic = collectTerminalRenderDiagnostic({
      surface: 'preview',
      stage: 'opened' as TerminalDiagnosticStage,
      terminal: fakeTerminal(lines),
      mount: mount as unknown as HTMLElement,
      fontFamily: 'monospace',
      fontSize: 13,
      document: documentLike as unknown as Document,
    });

    expect(diagnostic.bufferLines).toBe(800);
    expect(diagnostic.sampledBufferLines).toBe(512);
    expect(diagnostic.nonBlankBufferLines).toBe(1);
    expect(diagnostic.pixelsReadable).toBe(false);
    expect(diagnostic.nonTransparentPixels).toBe(0);
    expect(diagnostic.distinctColorCount).toBe(0);
  });
});
