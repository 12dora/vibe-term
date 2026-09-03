import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CanvasRenderer } from './canvas-renderer';
import {
  type FakeCanvasElement,
  type FakeDom,
  type FakeElement,
  installFakeDom,
} from './test-support/fake-dom';
import type {
  GhosttyRenderCell,
  GhosttyRenderCellStyle,
  GhosttyRenderRow,
  GhosttyRenderSnapshotMeta,
  GhosttyTheme,
} from './types';

const CELL = { width: 10, height: 16 };

const STYLE: GhosttyRenderCellStyle = {
  bold: false,
  italic: false,
  faint: false,
  blink: false,
  inverse: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: 0,
};

const THEME = {
  selectionBackground: 'rgba(80,80,80,0.4)',
  foreground: '#eeeeee',
} as GhosttyTheme;

function makeMeta(cols: number, rows: number, dirty: GhosttyRenderSnapshotMeta['dirty']) {
  return {
    cols,
    rows,
    dirty,
    colors: {
      background: { r: 17, g: 17, b: 17 },
      foreground: { r: 238, g: 238, b: 238 },
      cursor: null,
      palette: [],
    },
    cursor: {
      style: 'block' as const,
      visible: false,
      blinking: false,
      passwordInput: false,
      x: null,
      y: null,
      wideTail: false,
    },
  };
}

function makeRow(y: number, text: string, dirty: boolean): GhosttyRenderRow {
  const cells: GhosttyRenderCell[] = Array.from(text, (character, x) => ({
    x,
    text: character,
    codepoints: [character.codePointAt(0) ?? 32],
    widthKind: 'narrow' as const,
    hasText: true,
    style: STYLE,
    fgColor: null,
    bgColor: null,
  }));
  return { y, dirty, wrap: false, wrapContinuation: false, text, cells };
}

function fullFrame(texts: string[]) {
  return {
    meta: makeMeta(texts[0].length, texts.length, 'full' as const),
    rows: texts.map((text, y) => makeRow(y, text, true)),
    cellDimensions: CELL,
  };
}

function scrollFrame(texts: string[], scrollDelta: number, dirtyRow: number) {
  return {
    meta: makeMeta(texts[0].length, texts.length, 'partial' as const),
    rows: texts.map((text, y) => makeRow(y, text, y === dirtyRow)),
    cellDimensions: CELL,
    scrollDelta,
  };
}

function layerCanvas(screen: FakeElement, layer: string): FakeCanvasElement {
  const canvas = screen.children.find((child) => child.dataset.layer === layer);
  if (!canvas) {
    throw new Error(`layer ${layer} unavailable`);
  }
  return canvas as FakeCanvasElement;
}

function operationsOfType(canvas: FakeCanvasElement, type: string): Array<Record<string, unknown>> {
  return canvas.context.operations.filter((operation) => operation.type === type);
}

describe('CanvasRenderer shared scratch canvas', () => {
  let dom: FakeDom;
  let createdCanvases: FakeCanvasElement[];

  beforeEach(() => {
    dom = installFakeDom();
    createdCanvases = [];
    const createElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = (tagName: string): FakeElement => {
      const element = createElement(tagName);
      if (tagName.toLowerCase() === 'canvas') {
        createdCanvases.push(element as FakeCanvasElement);
      }
      return element;
    };
  });

  afterEach(() => {
    dom.restore();
  });

  function mount(): { screen: FakeElement; renderer: CanvasRenderer } {
    const screen = dom.document.createElement('div');
    const renderer = new CanvasRenderer({
      screenElement: screen as unknown as HTMLElement,
      theme: THEME,
      fontFamily: 'monospace',
      fontSize: 13,
    });
    return { screen, renderer };
  }

  test('blit runs on the fake DOM and resets the main fillStyle/font dedup after the swap', () => {
    const { screen, renderer } = mount();
    renderer.render(fullFrame(['AAAA', 'BBBB', 'CCCC', 'DDDD']));

    const previousMain = layerCanvas(screen, 'main');
    previousMain.context.operations = [];
    renderer.render(scrollFrame(['BBBB', 'CCCC', 'DDDD', 'ZZZZ'], 1, 3));

    const main = layerCanvas(screen, 'main');
    expect(main).not.toBe(previousMain);
    expect(previousMain.dataset.layer).toBe('scratch');
    expect(previousMain.style.opacity).toBe('0');
    expect(main.style.opacity).toBe('1');

    const blits = operationsOfType(main, 'drawImage');
    expect(blits).toHaveLength(1);
    expect(blits[0]).toMatchObject({
      source: previousMain,
      sourceX: 0,
      sourceY: CELL.height,
      sourceHeight: CELL.height * 3,
      destinationY: 0,
      globalCompositeOperation: 'copy',
    });
    // 位移复用成立时只补最后一行，前三行不再重画。
    expect(renderer.getDebugState().lastDrawnRows).toEqual([3]);

    // 交换到新画布后 fillStyle/font 的去重缓存必须失效，否则补画的行会带着空样式落笔。
    const fills = operationsOfType(main, 'fillRect');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((operation) => operation.fillStyle === 'rgb(17 17 17)')).toBe(true);
    const texts = operationsOfType(main, 'fillText');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((operation) => operation.fillStyle === 'rgb(238 238 238)')).toBe(true);
    expect(texts.every((operation) => operation.font !== '')).toBe(true);

    renderer.dispose();
  });

  test('two renderers alternate blits through a single shared scratch canvas', () => {
    const first = mount();
    const second = mount();
    expect(createdCanvases).toHaveLength(8);

    first.renderer.render(fullFrame(['AAAA', 'BBBB', 'CCCC', 'DDDD']));
    second.renderer.render(fullFrame(['1111', '2222', '3333', '4444']));
    expect(createdCanvases).toHaveLength(8);

    const firstMainBefore = layerCanvas(first.screen, 'main');
    first.renderer.render(scrollFrame(['BBBB', 'CCCC', 'DDDD', 'ZZZZ'], 1, 3));
    // 第一次 blit 才分配共享中转画布。
    expect(createdCanvases).toHaveLength(9);
    const shared = layerCanvas(first.screen, 'main');
    expect(shared).not.toBe(firstMainBefore);

    const secondMainBefore = layerCanvas(second.screen, 'main');
    second.renderer.render(scrollFrame(['2222', '3333', '4444', '9999'], 1, 3));
    // 第二个实例复用第一个实例让出的旧主画布，总量不增。
    expect(createdCanvases).toHaveLength(9);
    expect(layerCanvas(second.screen, 'main')).toBe(firstMainBefore);
    expect(secondMainBefore.dataset.layer).toBe('scratch');

    first.renderer.render(scrollFrame(['CCCC', 'DDDD', 'ZZZZ', 'YYYY'], 1, 3));
    expect(createdCanvases).toHaveLength(9);
    expect(layerCanvas(first.screen, 'main')).toBe(secondMainBefore);
    expect(first.renderer.getDebugState().lastDrawnRows).toEqual([3]);
    expect(second.renderer.getDebugState().lastDrawnRows).toEqual([3]);

    first.renderer.dispose();
    second.renderer.dispose();
  });

  test('disposing one renderer leaves the other able to blit', () => {
    const first = mount();
    const second = mount();
    first.renderer.render(fullFrame(['AAAA', 'BBBB', 'CCCC', 'DDDD']));
    second.renderer.render(fullFrame(['1111', '2222', '3333', '4444']));
    first.renderer.render(scrollFrame(['BBBB', 'CCCC', 'DDDD', 'ZZZZ'], 1, 3));

    first.renderer.dispose();
    expect(first.screen.children).toHaveLength(0);

    const secondMainBefore = layerCanvas(second.screen, 'main');
    secondMainBefore.context.operations = [];
    second.renderer.render(scrollFrame(['2222', '3333', '4444', '9999'], 1, 3));

    const secondMain = layerCanvas(second.screen, 'main');
    expect(secondMain).not.toBe(secondMainBefore);
    expect(operationsOfType(secondMain, 'drawImage')).toHaveLength(1);
    expect(second.renderer.getDebugState().lastDrawnRows).toEqual([3]);

    second.renderer.dispose();
    expect(second.screen.children).toHaveLength(0);
  });
});
