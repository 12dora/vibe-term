import { describe, expect, spyOn, test } from 'bun:test';
import { WINDOW_MEMORY_OOM_MARKS_KV_KEY, createWindowOomMarkStore } from './oom-mark-store';

function memoryKv(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    kv: {
      get(key: string): string | null {
        return data.get(key) ?? null;
      },
      set(key: string, value: string): void {
        data.set(key, value);
      },
    },
  };
}

describe('createWindowOomMarkStore', () => {
  test('has/mark/clear/list 按 device+window 粘性记录', () => {
    let now = 1_000;
    const { data, kv } = memoryKv();
    const store = createWindowOomMarkStore(kv, () => now);

    expect(store.has('dev-a', '@1')).toBe(false);
    expect(store.list()).toEqual([]);

    store.mark('dev-a', '@1', 'tmux-spawn-aaa.scope', 1);
    expect(store.has('dev-a', '@1')).toBe(true);
    expect(store.list()).toEqual([
      {
        deviceId: 'dev-a',
        windowId: '@1',
        scope: 'tmux-spawn-aaa.scope',
        oomKills: 1,
        firstAt: 1_000,
        lastAt: 1_000,
      },
    ]);

    now = 2_000;
    store.mark('dev-a', '@1', 'tmux-spawn-aaa.scope', 3);
    expect(store.list()[0]).toMatchObject({ oomKills: 3, firstAt: 1_000, lastAt: 2_000 });

    store.mark('dev-b', '@2', 'tmux-spawn-bbb.scope', 1);
    expect(store.list()).toHaveLength(2);

    store.clear('dev-a', '@1');
    expect(store.has('dev-a', '@1')).toBe(false);
    expect(store.list()).toEqual([
      {
        deviceId: 'dev-b',
        windowId: '@2',
        scope: 'tmux-spawn-bbb.scope',
        oomKills: 1,
        firstAt: 2_000,
        lastAt: 2_000,
      },
    ]);
    store.clear('dev-a', '@1');
    expect(JSON.parse(data.get(WINDOW_MEMORY_OOM_MARKS_KV_KEY) ?? '{}')).toEqual({
      'dev-b/@2': {
        scope: 'tmux-spawn-bbb.scope',
        oomKills: 1,
        firstAt: 2_000,
        lastAt: 2_000,
      },
    });
  });

  test('mark 不打 console.warn', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createWindowOomMarkStore(memoryKv().kv).mark('d', '@1', 'scope', 1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('缺省、损坏 JSON 与非法条目都当空表', () => {
    expect(createWindowOomMarkStore(memoryKv().kv).list()).toEqual([]);
    expect(
      createWindowOomMarkStore(memoryKv({ [WINDOW_MEMORY_OOM_MARKS_KV_KEY]: '{' }).kv).list()
    ).toEqual([]);
    expect(
      createWindowOomMarkStore(
        memoryKv({
          [WINDOW_MEMORY_OOM_MARKS_KV_KEY]: JSON.stringify({
            'dev/@1': { scope: 's', oomKills: 1, firstAt: 1, lastAt: 1 },
            bogus: { scope: 's' },
            'no-window': { scope: 's', oomKills: 1, firstAt: 1, lastAt: 1 },
          }),
        }).kv
      ).list()
    ).toEqual([
      { deviceId: 'dev', windowId: '@1', scope: 's', oomKills: 1, firstAt: 1, lastAt: 1 },
    ]);
  });

  test('读 kv 抛错时按空表处理', () => {
    const store = createWindowOomMarkStore({
      get() {
        throw new Error('kv down');
      },
      set() {},
    });
    expect(store.list()).toEqual([]);
    expect(store.has('d', '@1')).toBe(false);
  });
});
