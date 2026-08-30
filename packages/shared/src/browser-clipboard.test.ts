import { afterEach, describe, expect, it, jest, mock } from 'bun:test';
import {
  DEFERRED_CLIPBOARD_TTL_MS,
  type GestureEventTarget,
  createDeferredClipboardWriter,
  writeTextToClipboard,
} from './browser-clipboard';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

function stub(name: 'navigator' | 'document', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function makeHelper() {
  return {
    value: '',
    setAttribute: mock(() => {}),
    style: {} as Record<string, string>,
    select: mock(() => {}),
    remove: mock(() => {}),
  };
}

afterEach(() => {
  for (const [name, descriptor] of [
    ['navigator', originalNavigator],
    ['document', originalDocument],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

describe('writeTextToClipboard', () => {
  it('空串直接返回，不碰任何 API', async () => {
    stub('navigator', {});
    stub('document', undefined);
    await writeTextToClipboard('');
  });

  it('优先 Clipboard API', async () => {
    const writeText = mock(async () => {});
    stub('navigator', { clipboard: { writeText } });
    await writeTextToClipboard('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('Clipboard API 被拒后回退 textarea + execCommand 并清理 helper', async () => {
    stub('navigator', {
      clipboard: {
        writeText: mock(async () => {
          throw new Error('denied');
        }),
      },
    });
    const helper = makeHelper();
    const execCommand = mock(() => true);
    stub('document', {
      createElement: mock(() => helper),
      execCommand,
      body: { appendChild: mock((node: unknown) => node) },
    });

    await writeTextToClipboard('fallback');
    expect(helper.value).toBe('fallback');
    expect(helper.select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(helper.remove).toHaveBeenCalled();
  });

  it('execCommand 失败仍清理 helper 并抛错', async () => {
    stub('navigator', {});
    const helper = makeHelper();
    stub('document', {
      createElement: () => helper,
      execCommand: () => false,
      body: { appendChild: (node: unknown) => node },
    });

    await expect(writeTextToClipboard('x')).rejects.toThrow('execCommand copy failed');
    expect(helper.remove).toHaveBeenCalled();
  });

  it('无 execCommand 时抛 clipboard unavailable', async () => {
    stub('navigator', {});
    stub('document', {});
    await expect(writeTextToClipboard('x')).rejects.toThrow('clipboard unavailable');
  });
});

interface FakeGestureTarget extends GestureEventTarget {
  listenerCount(): number;
  fire(type: string): void;
}

function fakeGestureTarget(): FakeGestureTarget {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount() {
      let total = 0;
      for (const bucket of listeners.values()) total += bucket.size;
      return total;
    },
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

function fakeHandlers() {
  return {
    calls: [] as string[],
    make(calls: string[]) {
      return {
        onPending: () => calls.push('pending'),
        onSuccess: () => calls.push('success'),
        onFailure: () => calls.push('failure'),
      };
    },
  };
}

function createWriterHarness(write: (text: string) => Promise<void>, ttlMs?: number) {
  const calls: string[] = [];
  const target = fakeGestureTarget();
  const writer = createDeferredClipboardWriter(fakeHandlers().make(calls), {
    write,
    target,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  return { calls, target, writer };
}

describe('createDeferredClipboardWriter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('写入成功时立即回调 success，不挂起任何监听', async () => {
    const write = mock(async () => {});
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('hello');

    expect(write).toHaveBeenCalledWith('hello');
    expect(calls).toEqual(['success']);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);
  });

  it('首次失败后挂起，下一次用户手势里重试成功', async () => {
    let allow = false;
    const write = mock(async (_text: string) => {
      if (!allow) throw new Error('no user activation');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('deferred');
    expect(calls).toEqual(['pending']);
    expect(writer.hasPending()).toBe(true);
    expect(target.listenerCount()).toBeGreaterThan(0);

    allow = true;
    target.fire('pointerdown');
    await Promise.resolve();

    expect(write.mock.calls.map((call) => call[0])).toEqual(['deferred', 'deferred']);
    expect(calls).toEqual(['pending', 'success']);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);
  });

  it('手势里二次失败只报一次 failure 并拆掉监听', async () => {
    const write = mock(async () => {
      throw new Error('denied');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('deferred');
    target.fire('keydown');
    await Promise.resolve();
    target.fire('keydown');

    expect(calls).toEqual(['pending', 'failure']);
    expect(target.listenerCount()).toBe(0);
  });

  it('TTL 到期未等到手势则报 failure 并放弃', async () => {
    jest.useFakeTimers();
    const write = mock(async () => {
      throw new Error('denied');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('deferred');
    jest.advanceTimersByTime(DEFERRED_CLIPBOARD_TTL_MS + 1);

    expect(calls).toEqual(['pending', 'failure']);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);

    target.fire('pointerdown');
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('挂起期间再来一次复制：最新文本获胜，只提示一次并重置 TTL', async () => {
    jest.useFakeTimers();
    let allow = false;
    const write = mock(async (_text: string) => {
      if (!allow) throw new Error('denied');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('first');
    jest.advanceTimersByTime(DEFERRED_CLIPBOARD_TTL_MS - 1);
    await writer.write('second');
    expect(calls).toEqual(['pending']);

    jest.advanceTimersByTime(DEFERRED_CLIPBOARD_TTL_MS - 1);
    expect(writer.hasPending()).toBe(true);

    allow = true;
    target.fire('touchend');
    await Promise.resolve();

    expect(write.mock.calls.map((call) => call[0])).toEqual(['first', 'second', 'second']);
    expect(calls).toEqual(['pending', 'success']);
  });

  it('挂起期间的一次直接成功会丢弃过期挂起', async () => {
    let allow = false;
    const write = mock(async (_text: string) => {
      if (!allow) throw new Error('denied');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('stale');
    allow = true;
    await writer.write('fresh');

    expect(calls).toEqual(['pending', 'success']);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);
  });

  it('没有可挂手势的宿主（target 为 null）直接报 failure', async () => {
    const calls: string[] = [];
    const writer = createDeferredClipboardWriter(fakeHandlers().make(calls), {
      write: async () => {
        throw new Error('denied');
      },
      target: null,
    });

    await writer.write('x');
    expect(calls).toEqual(['failure']);
    expect(writer.hasPending()).toBe(false);
  });

  /** 手工控制每次写入何时完成，用来构造乱序完成 */
  function gatedWrite() {
    const gates: Array<{ resolve: () => void; reject: () => void }> = [];
    const write = mock(
      (_text: string) =>
        new Promise<void>((resolve, reject) => {
          gates.push({ resolve, reject: () => reject(new Error('denied')) });
        })
    );
    return { gates, write };
  }

  it('乱序完成：新写入先成功后，迟到的旧写入失败不再挂起', async () => {
    const { gates, write } = gatedWrite();
    const { calls, target, writer } = createWriterHarness(write);

    const stale = writer.write('stale');
    const fresh = writer.write('fresh');
    gates[1].resolve();
    await fresh;
    gates[0].reject();
    await stale;

    expect(calls).toEqual(['success']);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);
  });

  it('乱序完成：新写入失败挂起后，迟到的旧写入成功不清掉挂起的新文本', async () => {
    const { gates, write } = gatedWrite();
    const { calls, target, writer } = createWriterHarness(write);

    const stale = writer.write('stale');
    const fresh = writer.write('fresh');
    gates[1].reject();
    await fresh;
    expect(calls).toEqual(['pending']);
    expect(writer.hasPending()).toBe(true);

    gates[0].resolve();
    await stale;
    expect(calls).toEqual(['pending']);
    expect(writer.hasPending()).toBe(true);

    target.fire('pointerdown');
    gates[2].resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(write.mock.calls.map((call) => call[0])).toEqual(['stale', 'fresh', 'fresh']);
    expect(calls).toEqual(['pending', 'success']);
    expect(target.listenerCount()).toBe(0);
  });

  it('dispose 后在途写入失败：不重新注册手势监听也不回调', async () => {
    const { gates, write } = gatedWrite();
    const { calls, target, writer } = createWriterHarness(write);

    const inFlight = writer.write('deferred');
    writer.dispose();
    gates[0].reject();
    await inFlight;

    expect(calls).toEqual([]);
    expect(writer.hasPending()).toBe(false);
    expect(target.listenerCount()).toBe(0);
  });

  it('dispose 拆掉监听与定时器，不再回调', async () => {
    jest.useFakeTimers();
    const write = mock(async () => {
      throw new Error('denied');
    });
    const { calls, target, writer } = createWriterHarness(write);

    await writer.write('deferred');
    writer.dispose();
    jest.advanceTimersByTime(DEFERRED_CLIPBOARD_TTL_MS * 2);
    target.fire('pointerdown');

    expect(calls).toEqual(['pending']);
    expect(target.listenerCount()).toBe(0);
  });
});
