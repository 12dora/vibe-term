// 自动弹出的抽屉不该带走焦点：Base UI 打开对话框时把焦点移到抽屉里的第一个可聚焦元素
// （侧边栏顶上的「关闭侧边栏」），PWA 冷启动后左上角就一直挂着一圈焦点环。
// 无 DOM 测试环境：这里把 document 与 rAF 换成可手动推进的替身，验证收回窗口的行为。

import { afterEach, describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

type Listener = (event: { target: unknown }) => void;

class FakeDocument {
  listeners = new Set<Listener>();
  addEventListener(type: string, listener: Listener) {
    if (type === 'focusin') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: Listener) {
    if (type === 'focusin') this.listeners.delete(listener);
  }
  focusin(target: unknown) {
    for (const listener of [...this.listeners]) listener({ target });
  }
}

class FakeFrames {
  private queue = new Map<number, () => void>();
  private next = 1;
  request = (callback: () => void) => {
    const id = this.next++;
    this.queue.set(id, callback);
    return id;
  };
  cancel = (id: number) => {
    this.queue.delete(id);
  };
  tick() {
    const pending = [...this.queue.entries()];
    this.queue.clear();
    for (const [, callback] of pending) callback();
  }
}

function sheetElement(insideSheet: boolean) {
  let blurred = false;
  return {
    closest: (selector: string) =>
      insideSheet && selector === '[data-slot="sheet-content"]' ? {} : null,
    blur: () => {
      blurred = true;
    },
    get blurred() {
      return blurred;
    },
  };
}

const saved = {
  document: Reflect.getOwnPropertyDescriptor(globalThis, 'document'),
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};

function install(): { doc: FakeDocument; frames: FakeFrames } {
  const doc = new FakeDocument();
  const frames = new FakeFrames();
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  globalThis.requestAnimationFrame = frames.request as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = frames.cancel as unknown as typeof cancelAnimationFrame;
  return { doc, frames };
}

afterEach(() => {
  if (saved.document) Object.defineProperty(globalThis, 'document', saved.document);
  else Reflect.deleteProperty(globalThis, 'document');
  globalThis.requestAnimationFrame = saved.raf;
  globalThis.cancelAnimationFrame = saved.caf;
});

const { suppressAutoOpenFocus } = await import('./standalone-landing');

describe('suppressAutoOpenFocus', () => {
  test('焦点落进抽屉时收回来，之后不再拦截', () => {
    const { doc } = install();
    suppressAutoOpenFocus();
    const closeButton = sheetElement(true);
    doc.focusin(closeButton);
    expect(closeButton.blurred).toBe(true);
    expect(doc.listeners.size).toBe(0);

    const later = sheetElement(true);
    doc.focusin(later);
    expect(later.blurred).toBe(false);
  });

  test('焦点落在抽屉外的一律不动', () => {
    const { doc } = install();
    suppressAutoOpenFocus();
    const outside = sheetElement(false);
    doc.focusin(outside);
    expect(outside.blurred).toBe(false);
    expect(doc.listeners.size).toBe(1);
  });

  test('两帧之内没人移动焦点就撤掉监听，不碰用户自己点出来的焦点', () => {
    const { doc, frames } = install();
    suppressAutoOpenFocus();
    frames.tick();
    expect(doc.listeners.size).toBe(1);
    frames.tick();
    expect(doc.listeners.size).toBe(0);

    const tapped = sheetElement(true);
    doc.focusin(tapped);
    expect(tapped.blurred).toBe(false);
  });

  test('返回的清理函数立刻撤掉监听（effect 重跑 / 卸载时）', () => {
    const { doc } = install();
    const stop = suppressAutoOpenFocus();
    expect(doc.listeners.size).toBe(1);
    stop();
    expect(doc.listeners.size).toBe(0);
  });

  test('没有 document（SSR）时是个空操作', () => {
    Reflect.deleteProperty(globalThis, 'document');
    expect(() => suppressAutoOpenFocus()()).not.toThrow();
  });
});
