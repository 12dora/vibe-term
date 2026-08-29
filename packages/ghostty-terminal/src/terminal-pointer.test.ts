import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type PointerEventContext,
  type TerminalLinkHit,
  bindMouseEvents,
  createMouseInputState,
} from './terminal-pointer';

type Listener = (event: unknown) => void;

class FakeElement {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeMouseEvent {
  button = 0;
  buttons = 1;
  clientX = 0;
  clientY = 0;
  shiftKey = false;
  ctrlKey = false;
  altKey = false;
  metaKey = false;
  defaultPrevented = false;

  constructor(init: Partial<FakeMouseEvent> = {}) {
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Harness = {
  screen: FakeElement;
  calls: { linkProbes: number; presses: number; activations: number; selections: number };
};

function createHarness(options: {
  mouseReporting: boolean;
  linkHit?: TerminalLinkHit | null;
  throwOnLinkProbe?: boolean;
}): Harness {
  const root = new FakeElement();
  const screen = new FakeElement();
  const calls = { linkProbes: 0, presses: 0, activations: 0, selections: 0 };

  const context: PointerEventContext = {
    mouse: createMouseInputState(),
    isInputDisabled: () => false,
    focusTerminal: () => undefined,
    showScrollbarTransient: () => undefined,
    getInputRoutingState: () => ({ mouseReporting: options.mouseReporting, altScroll: false }),
    isAnyEventTrackingEnabled: () => false,
    pointerMods: () => 0,
    emitMouseInput: (request) => {
      if (request.action === 'press') {
        calls.presses += 1;
      }
      return true;
    },
    clearSelection: () => undefined,
    linkAtClient: () => {
      calls.linkProbes += 1;
      if (options.throwOnLinkProbe) {
        throw new Error('link hit-test exploded');
      }
      return options.linkHit ?? null;
    },
    activateLink: () => {
      calls.activations += 1;
    },
    setLinkCursor: () => undefined,
    beginPointerSelection: () => {
      calls.selections += 1;
    },
    updatePointerSelection: () => undefined,
    finishPointerSelection: () => undefined,
    handleViewportGesture: () => false,
  };

  bindMouseEvents(root as unknown as HTMLElement, screen as unknown as HTMLElement, context);

  return { screen, calls };
}

const platformModifierEvent = { ctrlKey: true, metaKey: true } as const;

describe('mousedown precedence', () => {
  let previousMouseEvent: unknown;

  beforeAll(() => {
    previousMouseEvent = (globalThis as { MouseEvent?: unknown }).MouseEvent;
    (globalThis as { MouseEvent?: unknown }).MouseEvent = FakeMouseEvent;
  });

  afterAll(() => {
    (globalThis as { MouseEvent?: unknown }).MouseEvent = previousMouseEvent;
  });

  test('mouse reporting reports without ever probing for a link', () => {
    const harness = createHarness({
      mouseReporting: true,
      linkHit: { kind: 'url', url: 'https://example.com' },
    });

    harness.screen.dispatch('mousedown', new FakeMouseEvent(platformModifierEvent));

    expect(harness.calls.presses).toBe(1);
    expect(harness.calls.linkProbes).toBe(0);
    expect(harness.calls.activations).toBe(0);
  });

  test('a throwing link hit-test cannot suppress mouse reporting', () => {
    const harness = createHarness({ mouseReporting: true, throwOnLinkProbe: true });

    harness.screen.dispatch('mousedown', new FakeMouseEvent(platformModifierEvent));

    expect(harness.calls.presses).toBe(1);
    expect(harness.calls.linkProbes).toBe(0);
  });

  test('shift bypass hands the modifier click back to link activation', () => {
    const harness = createHarness({
      mouseReporting: true,
      linkHit: { kind: 'url', url: 'https://example.com' },
    });

    harness.screen.dispatch(
      'mousedown',
      new FakeMouseEvent({ ...platformModifierEvent, shiftKey: true })
    );

    expect(harness.calls.presses).toBe(0);
    expect(harness.calls.linkProbes).toBe(1);
    expect(harness.calls.activations).toBe(1);
  });

  test('local mode probes once and falls back to selection when nothing is hit', () => {
    const harness = createHarness({ mouseReporting: false, linkHit: null });

    harness.screen.dispatch('mousedown', new FakeMouseEvent(platformModifierEvent));

    expect(harness.calls.linkProbes).toBe(1);
    expect(harness.calls.activations).toBe(0);
    expect(harness.calls.selections).toBe(1);
  });

  test('a plain left click never probes for a link', () => {
    const harness = createHarness({
      mouseReporting: false,
      linkHit: { kind: 'file', path: '/tmp/a.txt' },
    });

    harness.screen.dispatch('mousedown', new FakeMouseEvent());

    expect(harness.calls.linkProbes).toBe(0);
    expect(harness.calls.selections).toBe(1);
  });
});
