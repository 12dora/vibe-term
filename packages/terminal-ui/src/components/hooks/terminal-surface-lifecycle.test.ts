import { describe, expect, test } from 'bun:test';
import type { GatewayPaneScreenSnapshot } from '@tmex/ws-client';
import {
  TERMINAL_INIT_ERROR_MESSAGE,
  TERMINAL_RECOVERY_ERROR_MESSAGE,
  TERMINAL_RESOURCE_ERROR_MESSAGE,
  type TerminalBootState,
  type TerminalSurfaceCreationContext,
  type TerminalSurfaceHandle,
  TerminalSurfaceLifecycle,
  type TerminalSurfaceLifecycleDeps,
  bootErrorState,
  recoveryBootState,
  snapshotBootState,
} from './terminal-surface-lifecycle';

interface FakeTarget {
  id: string;
  dispose(): void;
}

const SNAPSHOT = { data: new Uint8Array() } as unknown as GatewayPaneScreenSnapshot;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  events: string[];
  lifecycle: TerminalSurfaceLifecycle<FakeTarget>;
  target: FakeTarget;
  resources: Deferred<void>;
  initialization: Deferred<FakeTarget>;
  states: TerminalBootState[];
  emitSnapshotApplied(snapshot: GatewayPaneScreenSnapshot | null): void;
  emitRecoveryRequired(reason: 'cache_evicted' | 'resource_exhausted'): void;
  surfaceCreated(): boolean;
}

function createHarness(options: { atomicScreen?: boolean } = {}): Harness {
  const events: string[] = [];
  const states: TerminalBootState[] = [];
  const resources = deferred<void>();
  const initialization = deferred<FakeTarget>();
  const atomicScreen = options.atomicScreen ?? true;
  let stored: TerminalSurfaceHandle<FakeTarget> | null = null;
  let handlers: TerminalSurfaceCreationContext<FakeTarget> | null = null;

  const target: FakeTarget = {
    id: 'target-0',
    dispose() {
      events.push('target:dispose');
    },
  };

  const deps: TerminalSurfaceLifecycleDeps<FakeTarget> = {
    async loadResources() {
      events.push('resources:load');
      await resources.promise;
    },
    createSurface(context) {
      events.push('surface:create');
      handlers = context;
      return {
        async initialize() {
          events.push('surface:initialize');
          return await initialization.promise;
        },
        dispose() {
          events.push('surface:dispose');
        },
        getVisibleTarget: () => target,
      };
    },
    getSurface: () => stored,
    setSurface(next) {
      events.push(`surface:set:${next === null ? 'null' : 'handle'}`);
      stored = next;
    },
    bindTarget(next) {
      events.push(`bind:${next === null ? 'null' : next.id}`);
    },
    setBootState(state) {
      states.push(state);
      events.push(`state:${state.status}`);
    },
    reportStage(stage, stageTarget) {
      events.push(`stage:${stage}:${stageTarget === null ? 'null' : stageTarget.id}`);
    },
    startDiagnosticSamples(sampleTarget) {
      events.push(`samples:start:${sampleTarget.id}`);
      return () => {
        events.push('samples:stop');
      };
    },
    supportsAtomicScreen: () => atomicScreen,
    requestPaneScreen() {
      events.push('request:paneScreen');
    },
    onSnapshotCommitted(committed) {
      events.push(`commit:${committed.id}`);
    },
  };

  return {
    events,
    lifecycle: new TerminalSurfaceLifecycle(deps),
    target,
    resources,
    initialization,
    states,
    emitSnapshotApplied(snapshot) {
      handlers?.onSnapshotApplied(target, snapshot);
    },
    emitRecoveryRequired(reason) {
      handlers?.onRecoveryRequired(reason);
    },
    surfaceCreated: () => handlers !== null,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('boot state transitions', () => {
  test('recoveryBootState only fires before the first committed snapshot on atomic transports', () => {
    expect(
      recoveryBootState({
        reason: 'cache_evicted',
        hasCommittedSnapshot: false,
        atomicScreen: true,
      })
    ).toEqual({ status: 'loading' });
    expect(
      recoveryBootState({
        reason: 'resource_exhausted',
        hasCommittedSnapshot: false,
        atomicScreen: true,
      })
    ).toEqual({ status: 'error', message: TERMINAL_RECOVERY_ERROR_MESSAGE });
    expect(
      recoveryBootState({
        reason: 'resource_exhausted',
        hasCommittedSnapshot: true,
        atomicScreen: true,
      })
    ).toBeNull();
    expect(
      recoveryBootState({
        reason: 'resource_exhausted',
        hasCommittedSnapshot: false,
        atomicScreen: false,
      })
    ).toBeNull();
  });

  test('snapshotBootState stays loading only when an atomic transport has no snapshot yet', () => {
    expect(snapshotBootState({ hasSnapshot: false, atomicScreen: true })).toEqual({
      status: 'loading',
    });
    expect(snapshotBootState({ hasSnapshot: true, atomicScreen: true })).toEqual({
      status: 'ready',
    });
    expect(snapshotBootState({ hasSnapshot: false, atomicScreen: false })).toEqual({
      status: 'ready',
    });
  });

  test('bootErrorState prefers the thrown message', () => {
    expect(bootErrorState(new Error('boom'), 'fallback')).toEqual({
      status: 'error',
      message: 'boom',
    });
    expect(bootErrorState('boom', 'fallback')).toEqual({ status: 'error', message: 'fallback' });
  });
});

describe('TerminalSurfaceLifecycle boot', () => {
  test('runs mount → fonts → surface → ready in order', async () => {
    const harness = createHarness({ atomicScreen: true });

    void harness.lifecycle.boot();
    expect(harness.events).toEqual([
      'surface:set:null',
      'bind:null',
      'state:loading',
      'stage:mount:null',
      'resources:load',
    ]);

    harness.resources.resolve();
    await flush();
    expect(harness.events.slice(5)).toEqual([
      'stage:fonts_ready:null',
      'surface:create',
      'surface:set:handle',
      'surface:initialize',
    ]);

    harness.events.length = 0;
    harness.emitSnapshotApplied(null);
    expect(harness.events).toEqual(['bind:target-0', 'state:loading', 'samples:start:target-0']);

    harness.events.length = 0;
    harness.emitSnapshotApplied(SNAPSHOT);
    expect(harness.events).toEqual([
      'bind:target-0',
      'commit:target-0',
      'stage:generation_activated:target-0',
      'state:ready',
      'samples:stop',
      'samples:start:target-0',
    ]);
    expect(harness.states.at(-1)).toEqual({ status: 'ready' });
  });

  test('non-atomic transports report ready without waiting for a snapshot', async () => {
    const harness = createHarness({ atomicScreen: false });
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.events.length = 0;
    harness.emitSnapshotApplied(null);

    expect(harness.states.at(-1)).toEqual({ status: 'ready' });
  });

  test('resource failure reports font_load_failed and stops before the surface', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();

    harness.resources.reject(new Error('fonts died'));
    await flush();

    expect(harness.events.slice(4)).toEqual([
      'resources:load',
      'stage:font_load_failed:null',
      'state:error',
    ]);
    expect(harness.states.at(-1)).toEqual({ status: 'error', message: 'fonts died' });
    expect(harness.surfaceCreated()).toBe(false);
  });

  test('non-Error resource failures fall back to the resource message', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();

    harness.resources.reject('nope');
    await flush();

    expect(harness.states.at(-1)).toEqual({
      status: 'error',
      message: TERMINAL_RESOURCE_ERROR_MESSAGE,
    });
  });

  test('initialize failure reports the init error message', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.initialization.reject('nope');
    await flush();

    expect(harness.states.at(-1)).toEqual({
      status: 'error',
      message: TERMINAL_INIT_ERROR_MESSAGE,
    });
  });
});

describe('TerminalSurfaceLifecycle cancellation', () => {
  test('cancelling while resources load skips the surface entirely', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();

    harness.lifecycle.cancel();
    harness.resources.resolve();
    await flush();

    expect(harness.surfaceCreated()).toBe(false);
    expect(harness.events).toEqual([
      'surface:set:null',
      'bind:null',
      'state:loading',
      'stage:mount:null',
      'resources:load',
      'surface:set:null',
      'bind:null',
    ]);
  });

  test('cancelling while resources load suppresses a late resource error', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();

    harness.lifecycle.cancel();
    harness.resources.reject(new Error('too late'));
    await flush();

    expect(harness.events).toContain('stage:font_load_failed:null');
    expect(harness.states).toEqual([{ status: 'loading' }]);
  });

  test('cancelling mid-initialize disposes the surface and suppresses its error', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.events.length = 0;
    harness.lifecycle.cancel();
    harness.initialization.reject(new Error('too late'));
    await flush();

    expect(harness.events).toEqual(['surface:dispose', 'surface:set:null', 'bind:null']);
    expect(harness.states).toEqual([{ status: 'loading' }]);
  });

  test('cancelled lifecycles ignore surface callbacks', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();
    harness.lifecycle.cancel();

    harness.events.length = 0;
    harness.emitSnapshotApplied(SNAPSHOT);
    harness.emitRecoveryRequired('cache_evicted');

    expect(harness.events).toEqual([]);
  });

  test('cancel stops the diagnostic samples started by the last snapshot', async () => {
    const harness = createHarness();
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();
    harness.emitSnapshotApplied(SNAPSHOT);

    harness.events.length = 0;
    harness.lifecycle.cancel();

    expect(harness.events[0]).toBe('samples:stop');
  });
});

describe('TerminalSurfaceLifecycle recovery', () => {
  test('recovery before the first snapshot drops back to loading and re-requests the screen', async () => {
    const harness = createHarness({ atomicScreen: true });
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.events.length = 0;
    harness.emitRecoveryRequired('cache_evicted');

    expect(harness.events).toEqual([
      'stage:recovery_started:target-0',
      'state:loading',
      'request:paneScreen',
    ]);
  });

  test('exhausted retries before the first snapshot surface a hard error', async () => {
    const harness = createHarness({ atomicScreen: true });
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.events.length = 0;
    harness.emitRecoveryRequired('resource_exhausted');

    expect(harness.states.at(-1)).toEqual({
      status: 'error',
      message: TERMINAL_RECOVERY_ERROR_MESSAGE,
    });
    expect(harness.events).toEqual([
      'stage:recovery_started:target-0',
      'state:error',
      'request:paneScreen',
    ]);
  });

  test('recovery after a committed snapshot keeps the ready state', async () => {
    const harness = createHarness({ atomicScreen: true });
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();
    harness.emitSnapshotApplied(SNAPSHOT);

    harness.events.length = 0;
    harness.emitRecoveryRequired('resource_exhausted');

    expect(harness.events).toEqual(['stage:recovery_started:target-0', 'request:paneScreen']);
    expect(harness.states.at(-1)).toEqual({ status: 'ready' });
  });

  test('recovery on non-atomic transports never touches the boot state', async () => {
    const harness = createHarness({ atomicScreen: false });
    void harness.lifecycle.boot();
    harness.resources.resolve();
    await flush();

    harness.events.length = 0;
    harness.emitRecoveryRequired('resource_exhausted');

    expect(harness.events).toEqual(['stage:recovery_started:target-0', 'request:paneScreen']);
  });

  test('resources already loaded (void return) build the surface without awaiting', () => {
    const events: string[] = [];
    const lifecycle = new TerminalSurfaceLifecycle<FakeTarget>({
      loadResources: () => {
        events.push('resources:load');
      },
      createSurface: () => {
        events.push('surface:create');
        return {
          initialize: () => {
            events.push('surface:initialize');
            return new Promise<FakeTarget>(() => {});
          },
          dispose: () => {},
          getVisibleTarget: () => null,
        };
      },
      getSurface: () => null,
      setSurface: () => {},
      bindTarget: () => {},
      setBootState: () => {},
      reportStage: (stage) => events.push(`stage:${stage}`),
      startDiagnosticSamples: () => () => {},
      supportsAtomicScreen: () => true,
      requestPaneScreen: () => {},
      onSnapshotCommitted: () => {},
    });

    void lifecycle.boot();

    // 没有一次 await：boot 调用返回时渲染面已经在建了
    expect(events).toEqual([
      'stage:mount',
      'resources:load',
      'stage:fonts_ready',
      'surface:create',
      'surface:initialize',
    ]);
  });

  test('a synchronous resource failure still lands on the resource error state', () => {
    const states: TerminalBootState[] = [];
    const lifecycle = new TerminalSurfaceLifecycle<FakeTarget>({
      loadResources: () => {
        throw new Error('boom');
      },
      createSurface: () => {
        throw new Error('should not create a surface');
      },
      getSurface: () => null,
      setSurface: () => {},
      bindTarget: () => {},
      setBootState: (state) => states.push(state),
      reportStage: () => {},
      startDiagnosticSamples: () => () => {},
      supportsAtomicScreen: () => true,
      requestPaneScreen: () => {},
      onSnapshotCommitted: () => {},
    });

    void lifecycle.boot();

    expect(states.at(-1)).toEqual({ status: 'error', message: 'boom' });
  });
});
