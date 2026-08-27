import { describe, expect, test } from 'bun:test';
import {
  RENDER_TARGET_CANCELLED_MESSAGE,
  RENDER_TARGET_HOST_MISSING_MESSAGE,
  type RenderTargetDeps,
  type RenderTargetMount,
  type RenderTargetStage,
  activateRenderTarget,
  createHiddenMount,
  createTerminalRenderTarget,
} from './terminal-render-target';

class FakeMount implements RenderTargetMount {
  className = '';
  style = { visibility: '', pointerEvents: '' };
  removed = 0;

  constructor(
    private readonly events: string[],
    readonly id: string
  ) {}

  remove(): void {
    this.removed += 1;
    this.events.push(`mount:remove:${this.id}`);
  }
}

class FakeTerminal {
  opened: FakeMount | null = null;
  disposed = 0;
  scrolled = 0;
  repainted = 0;

  constructor(
    private readonly events: string[],
    private readonly openError: Error | null = null
  ) {}

  open(mount: FakeMount): void {
    this.opened = mount;
    this.events.push('terminal:open');
    if (this.openError) throw this.openError;
  }

  dispose(): void {
    this.disposed += 1;
    this.events.push('terminal:dispose');
  }

  scrollToBottom(): void {
    this.scrolled += 1;
    this.events.push('terminal:scrollToBottom');
  }

  forceFullRepaint(): void {
    this.repainted += 1;
    this.events.push('terminal:forceFullRepaint');
  }
}

interface Harness {
  events: string[];
  deps: RenderTargetDeps<FakeMount, FakeTerminal>;
  terminal: FakeTerminal;
  mounts: FakeMount[];
  stages: Array<{
    stage: RenderTargetStage;
    terminal: FakeTerminal | null;
    mount: FakeMount | null;
  }>;
}

function createHarness(
  overrides: {
    controllerError?: Error;
    openError?: Error;
    missingHost?: boolean;
    cancelAfterController?: boolean;
  } = {}
): Harness {
  const events: string[] = [];
  const mounts: FakeMount[] = [];
  const stages: Harness['stages'] = [];
  const terminal = new FakeTerminal(events, overrides.openError ?? null);
  let cancelled = false;

  const host = {
    appendChild(mount: FakeMount) {
      events.push(`host:append:${mount.id}`);
      return mount;
    },
  };

  const deps: RenderTargetDeps<FakeMount, FakeTerminal> = {
    document: {
      createElement(tagName: 'div') {
        const mount = new FakeMount(events, `${tagName}${mounts.length}`);
        mounts.push(mount);
        events.push(`document:createElement:${mount.id}`);
        return mount;
      },
    },
    async createController() {
      events.push('controller:create');
      if (overrides.controllerError) throw overrides.controllerError;
      if (overrides.cancelAfterController) cancelled = true;
      return terminal;
    },
    isCancelled: () => cancelled,
    resolveHost: () => (overrides.missingHost ? null : host),
    reportStage(stage, stageTerminal, mount) {
      stages.push({ stage, terminal: stageTerminal, mount });
      events.push(`stage:${stage}`);
    },
    onDisposed(disposedTerminal) {
      events.push(`probe:clear:${disposedTerminal === terminal}`);
    },
  };

  return {
    events,
    deps,
    terminal,
    mounts,
    stages,
  };
}

describe('createHiddenMount', () => {
  test('offscreen buffer starts hidden and inert', () => {
    const events: string[] = [];
    const mount = createHiddenMount({
      createElement: (tagName: 'div') => new FakeMount(events, tagName),
    });

    expect(mount.className).toBe('absolute inset-0');
    expect(mount.style.visibility).toBe('hidden');
    expect(mount.style.pointerEvents).toBe('none');
  });
});

describe('createTerminalRenderTarget', () => {
  test('creates controller, opens a hidden mount, then reports ready', async () => {
    const harness = createHarness();

    const target = await createTerminalRenderTarget(harness.deps);

    expect(harness.events).toEqual([
      'controller:create',
      'document:createElement:div0',
      'host:append:div0',
      'stage:controller_ready',
      'terminal:open',
      'stage:opened',
    ]);
    expect(target.terminal).toBe(harness.terminal);
    expect(target.mount).toBe(harness.mounts[0] as FakeMount);
    expect(target.liveOutputEndedWithCR).toBe(false);
    expect(harness.terminal.opened).toBe(harness.mounts[0] as FakeMount);
    expect(
      harness.stages.map((entry) => [entry.stage, entry.terminal !== null, entry.mount !== null])
    ).toEqual([
      ['controller_ready', true, true],
      ['opened', true, true],
    ]);
  });

  test('mount stays hidden until it is activated', async () => {
    const harness = createHarness();

    const target = await createTerminalRenderTarget(harness.deps);

    expect(target.mount.style.visibility).toBe('hidden');
    expect(target.mount.style.pointerEvents).toBe('none');
  });

  test('cancellation after the controller resolves disposes it before any mount exists', async () => {
    const harness = createHarness({ cancelAfterController: true });

    await expect(createTerminalRenderTarget(harness.deps)).rejects.toThrow(
      RENDER_TARGET_CANCELLED_MESSAGE
    );

    expect(harness.events).toEqual(['controller:create', 'terminal:dispose']);
    expect(harness.mounts).toHaveLength(0);
  });

  test('missing host disposes the controller and reports no stage', async () => {
    const harness = createHarness({ missingHost: true });

    await expect(createTerminalRenderTarget(harness.deps)).rejects.toThrow(
      RENDER_TARGET_HOST_MISSING_MESSAGE
    );

    expect(harness.events).toEqual(['controller:create', 'terminal:dispose']);
    expect(harness.mounts).toHaveLength(0);
  });

  test('controller failure reports controller_failed and rethrows', async () => {
    const failure = new Error('wasm unavailable');
    const harness = createHarness({ controllerError: failure });

    await expect(createTerminalRenderTarget(harness.deps)).rejects.toThrow(failure);

    expect(harness.events).toEqual(['controller:create', 'stage:controller_failed']);
    expect(harness.stages[0]).toEqual({ stage: 'controller_failed', terminal: null, mount: null });
  });

  test('open failure reports open_failed, then disposes controller and mount', async () => {
    const failure = new Error('open blew up');
    const harness = createHarness({ openError: failure });

    await expect(createTerminalRenderTarget(harness.deps)).rejects.toThrow(failure);

    expect(harness.events).toEqual([
      'controller:create',
      'document:createElement:div0',
      'host:append:div0',
      'stage:controller_ready',
      'terminal:open',
      'stage:open_failed',
      'terminal:dispose',
      'mount:remove:div0',
    ]);
    const failed = harness.stages[1];
    expect(failed?.terminal).toBe(harness.terminal);
    expect(failed?.mount).toBe(harness.mounts[0] as FakeMount);
  });

  test('dispose clears the e2e probe before tearing down controller and mount', async () => {
    const harness = createHarness();
    const target = await createTerminalRenderTarget(harness.deps);
    harness.events.length = 0;

    target.dispose();

    expect(harness.events).toEqual(['probe:clear:true', 'terminal:dispose', 'mount:remove:div0']);
  });
});

describe('activateRenderTarget', () => {
  test('swaps the offscreen buffer in and repaints it', async () => {
    const harness = createHarness();
    const target = await createTerminalRenderTarget(harness.deps);
    harness.events.length = 0;

    activateRenderTarget(target);

    expect(target.mount.style.visibility).toBe('visible');
    expect(target.mount.style.pointerEvents).toBe('auto');
    expect(harness.events).toEqual(['terminal:scrollToBottom', 'terminal:forceFullRepaint']);
  });

  test('tolerates controllers without forceFullRepaint', () => {
    const events: string[] = [];
    const mount = new FakeMount(events, 'div0');
    const terminal = {
      open() {},
      dispose() {},
      scrollToBottom() {
        events.push('terminal:scrollToBottom');
      },
    };

    activateRenderTarget({ terminal, mount });

    expect(events).toEqual(['terminal:scrollToBottom']);
    expect(mount.style.visibility).toBe('visible');
  });
});
