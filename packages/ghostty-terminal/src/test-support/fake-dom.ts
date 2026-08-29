// terminal 控制器测试共用的 DOM / rAF / canvas / bindings 假实现。
// terminal.canvas.test.ts、terminal.ime.issue45.test.ts、issue45-cross-bug.test.ts 共享，
// 文件私有的扩展（鼠标事件类、render-state mock）留在各自测试文件里。
import { mock } from 'bun:test';
import * as realGhosttyWasm from '../ghostty-wasm';
import * as realRenderState from '../render-state';
import type { GhosttyTheme } from '../types';

// mock.module 前的导出值快照：namespace import 是 live binding，mock 生效后
// realGhosttyWasm.* 会跟着变成 fake，还原必须用 mock 前拷出的值。
// 本模块只被测试文件在顶层 import，快照必然早于任何 mock.module 执行。
const realGhosttyWasmSnapshot = { ...realGhosttyWasm };
const realRenderStateSnapshot = { ...realRenderState };

export type FakeEvent = {
  type: string;
  data?: string | null;
  inputType?: string;
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
  code?: string;
  repeat?: boolean;
  button?: number;
  buttons?: number;
  clientX?: number;
  clientY?: number;
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  detail?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  cancelable?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  currentTarget?: EventTarget | null;
  preventDefault?: () => void;
  clipboardData?: { getData: (type: string) => string };
};

export type FakeEventListener = (event: FakeEvent) => void;
export type RafCallback = (timestamp: number) => void;

export interface FakeTextMetrics {
  width: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
}

export class FakeCanvasContext2D {
  fillStyle = '';
  strokeStyle = '';
  font = '';
  lineWidth = 1;
  textBaseline = 'top';
  imageSmoothingEnabled = false;
  globalAlpha = 1;
  operations: Array<Record<string, unknown>> = [];

  clearRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: 'clearRect', x, y, width, height });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({
      type: 'fillRect',
      x,
      y,
      width,
      height,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  fillText(text: string, x: number, y: number): void {
    this.operations.push({
      type: 'fillText',
      text,
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
    });
  }

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({
      type: 'strokeRect',
      x,
      y,
      width,
      height,
      strokeStyle: this.strokeStyle,
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.operations.push({ type: 'setTransform', a, b, c, d, e, f });
  }

  measureText(): FakeTextMetrics {
    const px = Number.parseFloat(this.font) || 13;
    return {
      fontBoundingBoxAscent: px * 0.8,
      fontBoundingBoxDescent: px * 0.3,
      actualBoundingBoxAscent: px * 0.7,
      actualBoundingBoxDescent: px * 0.2,
      width: px * 0.6,
    };
  }
}

export class FakeElement {
  tagName: string;
  ownerDocument: FakeDocument;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  textContent = '';
  innerHTML = '';
  value = '';
  readOnly = false;
  tabIndex = 0;
  spellcheck = false;
  autocapitalize = '';
  autocomplete = '';
  attributes = new Map<string, string>();
  private rect = { width: 0, height: 0, left: 0, top: 0 };
  private listeners = new Map<string, FakeEventListener[]>();

  constructor(tagName: string, ownerDocument: FakeDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) {
      return;
    }

    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, listener: FakeEventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeEventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((current) => current !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }

    return !event.defaultPrevented;
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  getBoundingClientRect(): {
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }

  setBoundingClientRect(rect: {
    width: number;
    height: number;
    left?: number;
    top?: number;
  }): void {
    this.rect = {
      width: rect.width,
      height: rect.height,
      left: rect.left ?? 0,
      top: rect.top ?? 0,
    };
  }
}

export class FakeCanvasElement extends FakeElement {
  width = 0;
  height = 0;
  readonly context = new FakeCanvasContext2D();

  getContext(_kind?: string): FakeCanvasContext2D {
    return this.context;
  }
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  body: FakeElement;

  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName: string): FakeElement {
    if (tagName.toLowerCase() === 'canvas') {
      return new FakeCanvasElement(tagName, this);
    }

    return new FakeElement(tagName, this);
  }
}

export class FakeWindowTarget {
  document: FakeDocument;
  innerWidth = 1280;
  innerHeight = 720;
  private listeners = new Map<string, FakeEventListener[]>();

  constructor(document: FakeDocument) {
    this.document = document;
  }

  addEventListener(type: string, listener: FakeEventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeEventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((current) => current !== listener)
    );
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this as unknown as EventTarget;
    event.currentTarget = this as unknown as EventTarget;
    event.defaultPrevented ??= false;
    event.preventDefault ??= () => {
      event.defaultPrevented = true;
    };
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }

    return !event.defaultPrevented;
  }
}

export type FakeBindings = {
  createTerminal: (...args: any[]) => number;
  setTerminalTheme: (...args: any[]) => void;
  createKeyEncoder: () => number;
  createMouseEncoder: () => number;
  freeKeyEncoder: (...args: any[]) => void;
  freeMouseEncoder: (...args: any[]) => void;
  freeTerminal: (...args: any[]) => void;
  resizeTerminal: (...args: any[]) => void;
  writeVt: (...args: any[]) => void;
  resetTerminal: (...args: any[]) => void;
  resetMouseEncoder: (...args: any[]) => void;
  readScrollbar: (...args: any[]) => { total: number; offset: number; len: number };
  scrollViewportDelta: (...args: any[]) => void;
  scrollViewportTop: (...args: any[]) => void;
  scrollViewportBottom: (...args: any[]) => void;
  isTerminalModeEnabled: (...args: any[]) => boolean;
  setTerminalMode: (...args: any[]) => void;
  encodePaste: (...args: any[]) => string;
  encodeKeyEvent: (...args: any[]) => string;
  encodeMouseEvent: (...args: any[]) => string | null;
  formatViewport: (...args: any[]) => string;
  formatViewportCalls: number;
  modeState: Set<number>;
  scrollDeltaCalls: number[];
  mouseEventCalls: any[];
  keyEventCalls: any[];
};

export function createFakeBindings(): FakeBindings {
  let formatViewportCalls = 0;
  const modeState = new Set<number>();
  const scrollDeltaCalls: number[] = [];
  const mouseEventCalls: any[] = [];
  const keyEventCalls: any[] = [];

  return {
    createTerminal: () => 1,
    setTerminalTheme: () => {},
    createKeyEncoder: () => 2,
    createMouseEncoder: () => 3,
    freeKeyEncoder: () => {},
    freeMouseEncoder: () => {},
    freeTerminal: () => {},
    resizeTerminal: () => {},
    writeVt: () => {},
    resetTerminal: () => {},
    resetMouseEncoder: () => {},
    readScrollbar: () => ({ total: 24, offset: 0, len: 24 }),
    scrollViewportDelta: (_terminal: number, amount: number) => {
      scrollDeltaCalls.push(amount);
    },
    scrollViewportTop: () => {},
    scrollViewportBottom: () => {},
    isTerminalModeEnabled: (_terminal: number, mode: number) => modeState.has(mode),
    setTerminalMode: (_terminal: number, mode: number, enabled: boolean) => {
      if (enabled) modeState.add(mode);
      else modeState.delete(mode);
    },
    encodePaste: () => '',
    encodeKeyEvent: (
      _encoder: number,
      _terminal: number,
      options: { action: string; keyCode: number; mods: number }
    ) => {
      keyEventCalls.push(options);
      return `key:${options.action}:${options.keyCode}:${options.mods}`;
    },
    encodeMouseEvent: (_encoder: number, _terminal: number, options: Record<string, unknown>) => {
      mouseEventCalls.push(options);
      return `mouse:${String(options.action)}:${String(options.button ?? 'none')}`;
    },
    formatViewport: () => {
      formatViewportCalls += 1;
      return '';
    },
    get formatViewportCalls() {
      return formatViewportCalls;
    },
    modeState,
    scrollDeltaCalls,
    mouseEventCalls,
    keyEventCalls,
  };
}

export interface InstallFakeDomOptions {
  /** 覆盖 globalThis.MouseEvent；默认空类，只满足 instanceof 之外的占位需求。 */
  mouseEvent?: unknown;
  /** 覆盖 globalThis.WheelEvent；同上。 */
  wheelEvent?: unknown;
}

export interface FakeDom {
  document: FakeDocument;
  window: FakeWindowTarget;
  flushAnimationFrames: () => Promise<void>;
  pendingAnimationFrames: () => number;
  cancelledFrames: number[];
  restore: () => void;
}

const PATCHED_GLOBAL_KEYS = [
  'document',
  'window',
  'navigator',
  'HTMLElement',
  'HTMLCanvasElement',
  'HTMLTextAreaElement',
  'HTMLDivElement',
  'MouseEvent',
  'WheelEvent',
  'devicePixelRatio',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

export function installFakeDom(options: InstallFakeDomOptions = {}): FakeDom {
  const document = new FakeDocument();
  const windowTarget = new FakeWindowTarget(document);
  const previous = new Map<string, unknown>();
  for (const key of PATCHED_GLOBAL_KEYS) {
    previous.set(key, (globalThis as any)[key]);
  }

  const rafQueue = new Map<number, RafCallback>();
  const cancelledFrames: number[] = [];
  let nextAnimationFrameId = 1;

  (globalThis as any).document = document;
  (globalThis as any).window = windowTarget;
  (globalThis as any).navigator = {
    clipboard: {
      readText: async () => '',
      writeText: async () => {},
    },
  };
  (globalThis as any).HTMLElement = FakeElement;
  (globalThis as any).HTMLCanvasElement = FakeCanvasElement;
  (globalThis as any).HTMLTextAreaElement = FakeElement;
  (globalThis as any).HTMLDivElement = FakeElement;
  (globalThis as any).MouseEvent = options.mouseEvent ?? class {};
  (globalThis as any).WheelEvent = options.wheelEvent ?? class {};
  (globalThis as any).devicePixelRatio = 1;
  globalThis.requestAnimationFrame = ((callback: RafCallback) => {
    const id = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    rafQueue.set(id, callback);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    cancelledFrames.push(id);
    rafQueue.delete(id);
  }) as typeof cancelAnimationFrame;

  return {
    document,
    window: windowTarget,
    async flushAnimationFrames(): Promise<void> {
      const queued = [...rafQueue.entries()];
      rafQueue.clear();
      for (const [id, callback] of queued) {
        if (!cancelledFrames.includes(id)) {
          callback(0);
        }
      }
    },
    pendingAnimationFrames(): number {
      return rafQueue.size;
    },
    cancelledFrames,
    restore(): void {
      for (const [key, value] of previous.entries()) {
        (globalThis as any)[key] = value;
      }
    },
  };
}

export function findElementsByTag(root: FakeElement | null, tagName: string): FakeElement[] {
  if (!root) {
    return [];
  }

  const results: FakeElement[] = [];
  const target = tagName.toUpperCase();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.tagName === target) {
      results.push(current);
    }

    stack.push(...current.children);
  }

  return results;
}

export function findElementByClass(
  root: FakeElement | null,
  className: string
): FakeElement | null {
  if (!root) {
    return null;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    if (current.className === className) {
      return current;
    }

    stack.push(...current.children);
  }

  return null;
}

export function findCanvasByLayer(
  root: FakeElement | null,
  layer: string
): FakeCanvasElement | null {
  return (
    (findElementsByTag(root, 'canvas').find(
      (element) => (element as FakeCanvasElement).dataset.layer === layer
    ) as FakeCanvasElement | undefined) ?? null
  );
}

export function findHelperTextarea(root: FakeElement | null): FakeElement | undefined {
  return findElementByClass(root, 'xterm-helper-textarea') ?? undefined;
}

export const TEST_THEME: GhosttyTheme = {
  background: '#111111',
  foreground: '#eeeeee',
  cursor: '#ffffff',
  selectionBackground: '#334455',
  black: '#000000',
  red: '#aa0000',
  green: '#00aa00',
  yellow: '#aa5500',
  blue: '#0000aa',
  magenta: '#aa00aa',
  cyan: '#00aaaa',
  white: '#aaaaaa',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

/** 用 fake bindings 替换 ghostty-wasm；render-state 的 mock 由各测试文件按需提供。 */
export function mockGhosttyWasm(bindings: FakeBindings): void {
  mock.module('../ghostty-wasm', () => ({
    ...realGhosttyWasmSnapshot,
    keyboardEventToGhosttyMods: () => 0,
    getGhosttyBindings: async () => bindings,
  }));
}

type TrackedTerminal = { dispose: () => void };

const trackedTerminals = new Set<TrackedTerminal>();

// controller 会持有 selection 自动滚动 interval、rAF、DOM 监听等常驻资源。测试若不 dispose，
// 这些回调会活过 mock 还原，之后拿假资源去跑真 render-state 抛错，被 bun 记到当时正在跑的
// 任意测试文件头上并直接掐掉该文件（计数仍显示 0 fail）。
export function trackTerminal<T extends TrackedTerminal>(terminal: T): T {
  trackedTerminals.add(terminal);
  return terminal;
}

export function disposeTrackedTerminals(): void {
  for (const terminal of trackedTerminals) {
    terminal.dispose();
  }

  trackedTerminals.clear();
}

// bun 的 mock.module 是全局持久的（mock.restore 不还原），文件跑完必须显式还原，
// 否则污染同一进程中后续测试文件（如 headless.test.ts 拿到 fake bindings）。
// 还原前必须先 dispose 掉残留 controller，否则它们的定时回调会打到真模块上。
export function restoreRealTerminalModules(): void {
  disposeTrackedTerminals();
  mock.module('../ghostty-wasm', () => ({ ...realGhosttyWasmSnapshot }));
  mock.module('../render-state', () => ({ ...realRenderStateSnapshot }));
}
