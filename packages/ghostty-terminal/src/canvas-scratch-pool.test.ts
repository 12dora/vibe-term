import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SCRATCH_IDLE_RELEASE_MS, ScratchSurfacePool } from './canvas-scratch-pool';
import {
  type FakeCanvasElement,
  type FakeDocument,
  type FakeDom,
  installFakeDom,
} from './test-support/fake-dom';

type PendingTimer = { id: number; run: () => void; delay: number };

describe('ScratchSurfacePool', () => {
  let dom: FakeDom;
  let pending: PendingTimer[];
  let clock: number;
  let realSetTimeout: typeof setTimeout;
  let realClearTimeout: typeof clearTimeout;
  let realNow: () => number;

  beforeEach(() => {
    dom = installFakeDom();
    pending = [];
    clock = 1_000;
    let nextTimerId = 1;
    realSetTimeout = globalThis.setTimeout;
    realClearTimeout = globalThis.clearTimeout;
    realNow = Date.now;
    globalThis.setTimeout = ((run: () => void, delay: number) => {
      const id = nextTimerId;
      nextTimerId += 1;
      pending.push({ id, run, delay });
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      pending = pending.filter((timer) => timer.id !== id);
    }) as unknown as typeof clearTimeout;
    Date.now = () => clock;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Date.now = realNow;
    dom.restore();
  });

  function fireTimers(): void {
    const queued = pending;
    pending = [];
    for (const timer of queued) {
      timer.run();
    }
  }

  function ownerDocument(): Document {
    return dom.document as unknown as Document;
  }

  test('allocates a hidden scratch canvas lazily and reuses it for the same document', () => {
    const pool = new ScratchSurfacePool();
    expect(pool.parked).toBeNull();

    const surface = pool.acquire(ownerDocument());
    const canvas = surface.canvas as unknown as FakeCanvasElement;
    expect(canvas.dataset.layer).toBe('scratch');
    expect(canvas.style.opacity).toBe('0');
    expect(canvas.style.pointerEvents).toBe('none');
    expect(canvas.style.position).toBe('absolute');
    expect(pool.parked).toBe(surface);
    expect(pool.acquire(ownerDocument())).toBe(surface);
  });

  test('park replaces the held surface with the swapped-out canvas', () => {
    const pool = new ScratchSurfacePool();
    const first = pool.acquire(ownerDocument());
    const swappedOut = {
      canvas: dom.document.createElement('canvas') as unknown as HTMLCanvasElement,
      context: {} as CanvasRenderingContext2D,
    };

    pool.park(swappedOut);
    expect(pool.parked).toBe(swappedOut);
    // 顶替出去的那张此刻正是调用方的主画布，不能被池释放。
    expect((first.canvas as unknown as FakeCanvasElement).width).toBe(0);
    expect(first.canvas.parentElement).toBeNull();
  });

  test('drops and reallocates when the owning document changes', () => {
    const pool = new ScratchSurfacePool();
    const first = pool.acquire(ownerDocument());
    (first.canvas as unknown as FakeCanvasElement).width = 640;
    const otherDocument = new (dom.document.constructor as new () => FakeDocument)();

    const second = pool.acquire(otherDocument as unknown as Document);
    expect(second).not.toBe(first);
    expect((first.canvas as unknown as FakeCanvasElement).width).toBe(0);
  });

  test('releases the bitmap after the idle window and reallocates on the next blit', () => {
    const pool = new ScratchSurfacePool();
    const surface = pool.acquire(ownerDocument());
    const canvas = surface.canvas as unknown as FakeCanvasElement;
    canvas.width = 800;
    canvas.height = 600;
    dom.document.body.appendChild(canvas);
    expect(pending).toHaveLength(1);
    expect(pending[0].delay).toBe(SCRATCH_IDLE_RELEASE_MS);

    clock += SCRATCH_IDLE_RELEASE_MS;
    fireTimers();

    expect(pool.parked).toBeNull();
    expect(canvas.parentElement).toBeNull();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(pending).toHaveLength(0);

    expect(pool.acquire(ownerDocument())).not.toBe(surface);
  });

  test('keeps the surface while blits keep arriving and re-arms for the remainder', () => {
    const pool = new ScratchSurfacePool(SCRATCH_IDLE_RELEASE_MS);
    const surface = pool.acquire(ownerDocument());

    clock += 3_000;
    pool.acquire(ownerDocument());
    // 每帧 blit 不重设计时器，只更新最后使用时间。
    expect(pending).toHaveLength(1);

    clock += SCRATCH_IDLE_RELEASE_MS - 3_000;
    fireTimers();
    expect(pool.parked).toBe(surface);
    expect(pending).toHaveLength(1);
    expect(pending[0].delay).toBe(3_000);

    clock += 3_000;
    fireTimers();
    expect(pool.parked).toBeNull();
  });

  test('release cancels the idle timer', () => {
    const pool = new ScratchSurfacePool();
    const surface = pool.acquire(ownerDocument());
    dom.document.body.appendChild(surface.canvas as unknown as FakeCanvasElement);

    pool.release();
    expect(pool.parked).toBeNull();
    expect(pending).toHaveLength(0);
    expect(surface.canvas.parentElement).toBeNull();

    clock += SCRATCH_IDLE_RELEASE_MS;
    fireTimers();
    expect(pool.parked).toBeNull();
  });
});
