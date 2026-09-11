// fallback 语言的按需解锁：中文用户首屏不该白下一份 en_US.core / en_US.rest，
// 也不该因为「rest 还没到」那一瞬间的裸 key 就把整份 fallback 拉下来。

import { describe, expect, test } from 'bun:test';
import { type LocaleUnlock, createActiveCompleteWaiter, createLocaleUnlock } from './locale-unlock';

interface Harness {
  unlock: LocaleUnlock;
  loadedLanguages: string[];
  loadedRest: string[];
  /** 当前语言的 rest 落地 */
  completeActive: () => void;
  /** 复核时哪些 key 仍然缺 */
  setStillMissing: (missing: boolean) => void;
  reviewed: string[][];
}

function makeUnlock(options: { restRequested?: boolean; initial?: string } = {}): Harness {
  const loadedLanguages: string[] = [];
  const loadedRest: string[] = [];
  const reviewed: string[][] = [];
  let stillMissing = true;
  let completeActive: () => void = () => {};
  const active = new Promise<void>((resolve) => {
    completeActive = resolve;
  });

  const unlock = createLocaleUnlock({
    initial: options.initial ?? 'zh_CN',
    fallback: 'en_US',
    loadLanguage: (lng) => {
      loadedLanguages.push(lng);
      return Promise.resolve();
    },
    loadRest: (lng) => {
      loadedRest.push(lng);
      return Promise.resolve();
    },
    isRestRequested: () => options.restRequested === true,
    whenActiveComplete: () => active,
    hasMissingKeys: (keys) => {
      reviewed.push([...keys]);
      return stillMissing;
    },
  });

  return {
    unlock,
    loadedLanguages,
    loadedRest,
    completeActive,
    setStillMissing: (missing) => {
      stillMissing = missing;
    },
    reviewed,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('createLocaleUnlock', () => {
  test('首屏只解锁当前语言，fallback 语言不放行（backend 对它回空包）', () => {
    const { unlock } = makeUnlock();
    expect(unlock.isUnlocked('zh_CN')).toBe(true);
    expect(unlock.isUnlocked('en_US')).toBe(false);
    expect(unlock.isUnlocked('ja_JP')).toBe(false);
  });

  test('切语言前 unlock，之后 backend 才会真的去拉该语言', () => {
    const { unlock } = makeUnlock();
    unlock.unlock('ja_JP');
    expect(unlock.isUnlocked('ja_JP')).toBe(true);
  });

  test('当前语言的 rest 还没落地时不拉 fallback（这才是绝大多数裸 key 的原因）', async () => {
    const h = makeUnlock();
    h.unlock.recordMissingKey('settings.title');
    await settle();
    expect(h.reviewed).toEqual([]);
    expect(h.loadedLanguages).toEqual([]);
    expect(h.unlock.isUnlocked('en_US')).toBe(false);
  });

  test('rest 落地后复核：还缺就拉 fallback', async () => {
    const h = makeUnlock();
    h.unlock.recordMissingKey('settings.title');
    h.unlock.recordMissingKey('settings.subtitle');
    h.completeActive();
    await settle();
    expect(h.reviewed).toEqual([['settings.title', 'settings.subtitle']]);
    expect(h.loadedLanguages).toEqual(['en_US']);
    expect(h.unlock.isUnlocked('en_US')).toBe(true);
  });

  test('rest 落地后复核：不缺了就不拉，之后再缺还能再复核一轮', async () => {
    const h = makeUnlock();
    h.setStillMissing(false);
    h.unlock.recordMissingKey('settings.title');
    h.completeActive();
    await settle();
    expect(h.loadedLanguages).toEqual([]);

    h.setStillMissing(true);
    h.unlock.recordMissingKey('watch.title');
    await settle();
    expect(h.reviewed).toEqual([['settings.title'], ['watch.title']]);
    expect(h.loadedLanguages).toEqual(['en_US']);
  });

  test('rest 已被请求过时，fallback 的 rest 也一起补', async () => {
    const h = makeUnlock({ restRequested: true });
    h.unlock.requestFallback();
    await settle();
    expect(h.loadedLanguages).toEqual(['en_US']);
    expect(h.loadedRest).toEqual(['en_US']);
  });

  test('rest 没被请求过时只补 core', async () => {
    const h = makeUnlock();
    h.unlock.requestFallback();
    await settle();
    expect(h.loadedLanguages).toEqual(['en_US']);
    expect(h.loadedRest).toEqual([]);
  });

  test('拉过一次之后的缺 key 不再触发复核', async () => {
    const h = makeUnlock();
    h.unlock.requestFallback();
    await settle();
    h.unlock.recordMissingKey('settings.title');
    h.completeActive();
    await settle();
    expect(h.reviewed).toEqual([]);
    expect(h.loadedLanguages).toEqual(['en_US']);
  });

  test('当前语言就是 fallback 时，requestFallback 是空操作', async () => {
    const h = makeUnlock({ initial: 'en_US' });
    h.unlock.requestFallback();
    await settle();
    expect(h.loadedLanguages).toEqual([]);
  });

  test('fallback 加载失败不抛到调用方（渲染路径不能因此崩）', async () => {
    const unlock = createLocaleUnlock({
      initial: 'zh_CN',
      fallback: 'en_US',
      loadLanguage: () => Promise.reject(new Error('chunk failed')),
      loadRest: () => Promise.resolve(),
      isRestRequested: () => false,
      whenActiveComplete: () => Promise.resolve(),
      hasMissingKeys: () => true,
    });
    expect(() => unlock.recordMissingKey('x')).not.toThrow();
    await settle();
  });
});

describe('createActiveCompleteWaiter', () => {
  function fakeSleep() {
    const waits: number[] = [];
    return {
      waits,
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    };
  }

  test('rest 已请求：直接等它落地', async () => {
    const { waits, sleep } = fakeSleep();
    let loaded = 0;
    const wait = createActiveCompleteWaiter({
      isRestRequested: () => true,
      loadRest: () => {
        loaded += 1;
        return Promise.resolve();
      },
      sleep,
    });
    await wait();
    expect(waits).toEqual([]);
    expect(loaded).toBe(1);
  });

  test('rest 稍后才被请求：宽限期内等到就照常等它落地', async () => {
    const { waits, sleep } = fakeSleep();
    let requested = false;
    let loaded = 0;
    const wait = createActiveCompleteWaiter({
      isRestRequested: () => {
        const now = requested;
        requested = waits.length >= 2;
        return now;
      },
      loadRest: () => {
        loaded += 1;
        return Promise.resolve();
      },
      graceMs: 1000,
      pollMs: 100,
      sleep,
    });
    await wait();
    expect(loaded).toBe(1);
    expect(waits.length).toBeLessThan(10);
  });

  test('始终没人请求 rest：宽限期满后认定本页只用 core', async () => {
    const { waits, sleep } = fakeSleep();
    let loaded = 0;
    const wait = createActiveCompleteWaiter({
      isRestRequested: () => false,
      loadRest: () => {
        loaded += 1;
        return Promise.resolve();
      },
      graceMs: 1000,
      pollMs: 200,
      sleep,
    });
    await wait();
    expect(waits).toEqual([200, 200, 200, 200, 200]);
    expect(loaded).toBe(0);
  });

  test('rest 加载失败不抛（兜底路径不能炸）', async () => {
    const wait = createActiveCompleteWaiter({
      isRestRequested: () => true,
      loadRest: () => Promise.reject(new Error('chunk failed')),
      sleep: () => Promise.resolve(),
    });
    await expect(wait()).resolves.toBeUndefined();
  });
});
