// sonner 的 Toaster 订阅前发出的通知会被直接丢掉（初始 state 为空且不回放 ToastState.toasts），
// 门面必须自己排队并在订阅建立后按序补发。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { markToasterReady, resetToastQueueForTests, toast } from './toast';

interface Delivered {
  kind: string;
  message: string;
}

function fakeSonner() {
  const delivered: Delivered[] = [];
  const push = (kind: string) => (message: string) => {
    delivered.push({ kind, message });
  };
  const toastFn = Object.assign(push('message'), {
    success: push('success'),
    error: push('error'),
    warning: push('warning'),
    info: push('info'),
  });
  return {
    delivered,
    module: { toast: toastFn } as unknown as Pick<typeof import('sonner'), 'toast'>,
  };
}

let sonner = fakeSonner();

beforeEach(() => {
  sonner = fakeSonner();
  resetToastQueueForTests(async () => sonner.module);
});

afterAll(() => {
  resetToastQueueForTests(null);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('toast 门面的排队与补发', () => {
  test('Toaster 就位前的通知不丢，就位后按序补发', async () => {
    toast.error('连接断开');
    toast('watch 规则已保存');
    toast.success('已重连');

    await flush();
    expect(sonner.delivered).toEqual([]);

    markToasterReady();
    await flush();

    expect(sonner.delivered).toEqual([
      { kind: 'error', message: '连接断开' },
      { kind: 'message', message: 'watch 规则已保存' },
      { kind: 'success', message: '已重连' },
    ]);
  });

  test('就位后的通知直接下发，且排在补发之后', async () => {
    toast.info('排队的');
    markToasterReady();
    toast.warning('之后的');

    await flush();

    expect(sonner.delivered).toEqual([
      { kind: 'info', message: '排队的' },
      { kind: 'warning', message: '之后的' },
    ]);
  });

  test('补发只发生一次：重复标记 ready 不会重放', async () => {
    toast.error('只此一条');
    markToasterReady();
    markToasterReady();
    await flush();

    expect(sonner.delivered).toEqual([{ kind: 'error', message: '只此一条' }]);
  });

  test('Toaster 迟迟不来时积压有上限，丢最旧的', async () => {
    for (let index = 0; index < 40; index += 1) toast.info(`n${index}`);
    markToasterReady();
    await flush();

    expect(sonner.delivered).toHaveLength(32);
    expect(sonner.delivered[0]).toEqual({ kind: 'info', message: 'n8' });
    expect(sonner.delivered.at(-1)).toEqual({ kind: 'info', message: 'n39' });
  });

  test('sonner 加载失败时静默丢弃，不抛给调用方', async () => {
    resetToastQueueForTests(async () => {
      throw new Error('chunk 404');
    });
    toast.error('炸了');
    markToasterReady();

    await flush();
    expect(sonner.delivered).toEqual([]);
  });
});
