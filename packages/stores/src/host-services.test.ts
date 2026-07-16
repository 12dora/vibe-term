import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type HostServices, resolveRuntimeCore } from './runtime';

class MemStorage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  // @ts-ignore
  globalThis.localStorage = new MemStorage();
}

describe('default HostServices (browser)', () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalURL = globalThis.URL;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'URL', {
      value: originalURL,
      configurable: true,
      writable: true,
    });
  });

  test('resolveRuntimeCore 默认 host 暴露 clipboard/external/reload/saveFile', () => {
    const core = resolveRuntimeCore();
    expect(typeof core.host.writeClipboardText).toBe('function');
    expect(typeof core.host.readClipboardText).toBe('function');
    expect(typeof core.host.openExternal).toBe('function');
    expect(typeof core.host.reload).toBe('function');
    expect(typeof core.host.saveFile).toBe('function');
  });

  test('writeClipboardText 优先 Clipboard API', async () => {
    const writeText = mock(async () => {});
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    await host.writeClipboardText('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  test('writeClipboardText Clipboard API 失败后走 textarea/execCommand fallback 并清理 helper', async () => {
    const writeText = mock(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });

    const helpers: Array<{ remove: ReturnType<typeof mock>; select: ReturnType<typeof mock> }> = [];
    const appendChild = mock((node: { remove: () => void }) => node);
    const createElement = mock((tag: string) => {
      expect(tag).toBe('textarea');
      const helper = {
        value: '',
        setAttribute: mock(() => {}),
        style: {} as Record<string, string>,
        select: mock(() => {}),
        remove: mock(() => {}),
      };
      helpers.push(helper);
      return helper;
    });
    const execCommand = mock(() => true);
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement,
        execCommand,
        body: { appendChild },
      },
      configurable: true,
    });

    const host = resolveRuntimeCore().host;
    await host.writeClipboardText('fallback-text');
    expect(writeText).toHaveBeenCalled();
    expect(createElement).toHaveBeenCalledWith('textarea');
    expect(helpers[0].value).toBe('fallback-text');
    expect(helpers[0].select).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(helpers[0].remove).toHaveBeenCalled();
  });

  test('writeClipboardText fallback 失败时仍清理 helper', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: mock(async () => {
            throw new Error('denied');
          }),
        },
      },
      configurable: true,
    });
    const remove = mock(() => {});
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: () => ({
          value: '',
          setAttribute: () => {},
          style: {},
          select: () => {},
          remove,
        }),
        execCommand: () => false,
        body: { appendChild: (n: unknown) => n },
      },
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    await expect(host.writeClipboardText('x')).rejects.toThrow();
    expect(remove).toHaveBeenCalled();
  });

  test('readClipboardText 不可用时拒绝', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    await expect(host.readClipboardText()).rejects.toThrow('clipboard unavailable');
  });

  test('openExternal / reload 走 window', () => {
    const open = mock(() => null);
    const reload = mock(() => {});
    Object.defineProperty(globalThis, 'window', {
      value: { open, location: { reload } },
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    host.openExternal('https://example.com');
    host.reload();
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(reload).toHaveBeenCalled();
  });

  test('saveFile 使用 object URL + a[download] 并清理', async () => {
    const revokeObjectURL = mock(() => {});
    const createObjectURL = mock(() => 'blob:mock-url');
    Object.defineProperty(globalThis, 'URL', {
      value: { createObjectURL, revokeObjectURL },
      configurable: true,
    });

    const remove = mock(() => {});
    const click = mock(() => {});
    const anchor = {
      href: '',
      download: '',
      click,
      remove,
    };
    const appendChild = mock((n: unknown) => n);
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: (tag: string) => {
          expect(tag).toBe('a');
          return anchor;
        },
        body: { appendChild },
      },
      configurable: true,
    });

    const host = resolveRuntimeCore().host;
    const blob = new Blob(['abc']);
    await host.saveFile({ name: 'out.txt', blob });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(anchor.href).toBe('blob:mock-url');
    expect(anchor.download).toBe('out.txt');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  test('saveFile click 抛错仍清理 object URL 与 DOM helper', async () => {
    const revokeObjectURL = mock(() => {});
    Object.defineProperty(globalThis, 'URL', {
      value: {
        createObjectURL: () => 'blob:x',
        revokeObjectURL,
      },
      configurable: true,
    });
    const remove = mock(() => {});
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: () => ({
          href: '',
          download: '',
          click: () => {
            throw new Error('click failed');
          },
          remove,
        }),
        body: { appendChild: (n: unknown) => n },
      },
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    await expect(host.saveFile({ name: 'a', blob: new Blob(['1']) })).rejects.toThrow(
      'click failed'
    );
    expect(remove).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });

  test('saveFile appendChild 抛错仍清理 object URL', async () => {
    const revokeObjectURL = mock(() => {});
    Object.defineProperty(globalThis, 'URL', {
      value: { createObjectURL: () => 'blob:append', revokeObjectURL },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: {
        createElement: () => ({ href: '', download: '', click: () => {}, remove: () => {} }),
        body: {
          appendChild: () => {
            throw new Error('append failed');
          },
        },
      },
      configurable: true,
    });
    const host = resolveRuntimeCore().host;
    await expect(host.saveFile({ name: 'a', blob: new Blob(['1']) })).rejects.toThrow(
      'append failed'
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:append');
  });
});

describe('injected HostServices', () => {
  test('resolveRuntimeCore 使用注入 host，不建模块级可变单例', () => {
    const writes: string[] = [];
    const host: HostServices = {
      navigate: () => {},
      isMobile: () => false,
      openMobileSidebar: () => {},
      closeMobileSidebar: () => {},
      writeClipboardText: async (text) => {
        writes.push(text);
      },
      readClipboardText: async () => 'from-host',
      openExternal: () => {},
      reload: () => {},
      saveFile: async () => {},
    };
    const a = resolveRuntimeCore({ host });
    const b = resolveRuntimeCore({
      host: {
        ...host,
        writeClipboardText: async (text) => {
          writes.push(`b:${text}`);
        },
      },
    });
    expect(a.host).toBe(host);
    expect(b.host).not.toBe(host);
    void a.host.writeClipboardText('a');
    void b.host.writeClipboardText('x');
    expect(writes).toEqual(['a', 'b:x']);
  });
});
