import { afterEach, describe, expect, it, mock } from 'bun:test';
import { writeTextToClipboard } from './browser-clipboard';

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
