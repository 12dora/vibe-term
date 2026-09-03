// 懒面板的语言包前置条件：模块与 rest 语言包并行，两者都到位才挂载。

import { afterEach, describe, expect, test } from 'bun:test';
import { awaitI18nRest, setI18nRestPrerequisite, withI18nRest } from './rest-prerequisite';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setI18nRestPrerequisite(null));

describe('awaitI18nRest', () => {
  test('未注入前置条件时立即 resolve', async () => {
    await awaitI18nRest();
  });

  test('语言包加载失败也 resolve，不把面板卡在骨架上', async () => {
    setI18nRestPrerequisite(() => Promise.reject(new Error('offline')));
    await awaitI18nRest();
  });
});

describe('withI18nRest', () => {
  test('模块与语言包并行发起，两者都到位才交付', async () => {
    let releaseRest: (() => void) | null = null;
    let moduleStarted = false;
    setI18nRestPrerequisite(
      () =>
        new Promise<void>((resolve) => {
          releaseRest = resolve;
        })
    );

    const load = withI18nRest(async () => {
      moduleStarted = true;
      return 'panel';
    });

    let delivered: string | null = null;
    const pending = load().then((value) => {
      delivered = value;
      return value;
    });

    await tick();
    // 模块 import 已经并行发起了，但语言包没到就不该交付
    expect(moduleStarted).toBe(true);
    expect(delivered).toBeNull();

    (releaseRest as unknown as () => void)();
    expect(await pending).toBe('panel');
  });

  test('语言包失败仍然交付模块（退化成裸 key，好过永远不挂载）', async () => {
    setI18nRestPrerequisite(() => Promise.reject(new Error('offline')));
    const load = withI18nRest(async () => 'panel');
    expect(await load()).toBe('panel');
  });

  test('模块本身失败照旧抛出，交给 lazyChunk 的重试卡片', async () => {
    setI18nRestPrerequisite(() => Promise.resolve());
    const load = withI18nRest(async () => {
      throw new Error('chunk 404');
    });
    await expect(load()).rejects.toThrow('chunk 404');
  });
});
