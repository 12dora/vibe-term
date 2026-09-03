// clearTextarea() 在每次击键路径上被调用 11 次：contenteditable 子树即使写入同样的空串
// 也会让布局失效，而紧随其后的 positionTextareaAtCursor 要读几何。已经空就不该写 DOM。
import { afterEach, describe, expect, test } from 'bun:test';
import { TerminalDomSurface } from './terminal-dom';
import {
  type FakeDom,
  type FakeElement,
  TEST_THEME,
  findHelperTextarea,
  installFakeDom,
} from './test-support/fake-dom';

class FakeResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function trackTextContent(element: FakeElement): { writes: number } {
  const probe = { writes: 0 };
  let value = element.textContent;
  Object.defineProperty(element, 'textContent', {
    configurable: true,
    get(): string {
      return value;
    },
    set(next: string) {
      probe.writes += 1;
      value = next;
    },
  });
  return probe;
}

describe('clearTextarea 的空写守卫', () => {
  let dom: FakeDom | null = null;
  let previousResizeObserver: unknown;

  afterEach(() => {
    (globalThis as Record<string, unknown>).ResizeObserver = previousResizeObserver;
    dom?.restore();
    dom = null;
  });

  function setup() {
    dom = installFakeDom();
    previousResizeObserver = (globalThis as Record<string, unknown>).ResizeObserver;
    (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;

    const surface = new TerminalDomSurface({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 1000,
    });
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    surface.mount(container as unknown as HTMLElement);

    const textarea = findHelperTextarea(surface.element as unknown as FakeElement);
    if (!textarea) {
      throw new Error('helper textarea unavailable');
    }
    return { surface, textarea };
  }

  test('已经是空串时不写 DOM', () => {
    const { surface, textarea } = setup();
    const probe = trackTextContent(textarea);

    surface.clearTextarea();
    surface.clearTextarea();
    surface.clearTextarea();

    expect(probe.writes).toBe(0);
    expect(textarea.textContent).toBe('');
  });

  test('有内容时清空一次，随后的清空不再写 DOM', () => {
    const { surface, textarea } = setup();
    const probe = trackTextContent(textarea);

    textarea.textContent = '组合中';
    expect(probe.writes).toBe(1);

    surface.clearTextarea();
    expect(probe.writes).toBe(2);
    expect(textarea.textContent).toBe('');

    surface.clearTextarea();
    expect(probe.writes).toBe(2);
  });
});
