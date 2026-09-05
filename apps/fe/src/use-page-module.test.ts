import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAGE_MODULE_LOADING,
  type PageModule,
  type PageModuleState,
  cachedPageModule,
  clearPageModuleCache,
  initialPageModuleState,
  requestPageModule,
  setPageModulePrerequisite,
  syncPageModuleState,
  toPageModuleError,
} from './use-page-module';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function recorder() {
  const states: PageModuleState[] = [];
  return { states, apply: (state: PageModuleState) => void states.push(state) };
}

const pageModule: PageModule = { default: () => null };

describe('requestPageModule', () => {
  test('applies the loaded module', async () => {
    const { states, apply } = recorder();
    const gate = deferred<PageModule>();

    requestPageModule(() => gate.promise, apply);
    gate.resolve(pageModule);
    await gate.promise;

    expect(states).toEqual([{ status: 'ready', module: pageModule, error: null }]);
  });

  test('applies an error state instead of leaving the rejection unhandled', async () => {
    const { states, apply } = recorder();
    const failure = new Error('chunk load failed');

    requestPageModule(() => Promise.reject(failure), apply);
    await Promise.resolve();
    await Promise.resolve();

    expect(states).toEqual([{ status: 'error', module: null, error: failure }]);
  });

  test('wraps non-Error rejection reasons', async () => {
    const { states, apply } = recorder();

    requestPageModule(() => Promise.reject('boom'), apply);
    await Promise.resolve();
    await Promise.resolve();

    expect(states[0]?.status).toBe('error');
    expect(states[0]?.error?.message).toBe('boom');
  });

  test('a cancelled request never applies its result', async () => {
    const { states, apply } = recorder();
    const gate = deferred<PageModule>();

    const cancel = requestPageModule(() => gate.promise, apply);
    cancel();
    gate.resolve(pageModule);
    await gate.promise;

    expect(states).toEqual([]);
  });

  test('a cancelled request never applies its rejection', async () => {
    const { states, apply } = recorder();
    const gate = deferred<PageModule>();

    const cancel = requestPageModule(() => gate.promise, apply);
    cancel();
    gate.reject(new Error('chunk load failed'));
    await gate.promise.catch(() => undefined);

    expect(states).toEqual([]);
  });

  test('a stale request cannot overwrite the current one', async () => {
    const { states, apply } = recorder();
    const stale = deferred<PageModule>();
    const current = deferred<PageModule>();
    const currentModule: PageModule = { default: () => null };

    const cancelStale = requestPageModule(() => stale.promise, apply);
    cancelStale();
    requestPageModule(() => current.promise, apply);

    current.resolve(currentModule);
    await current.promise;
    stale.resolve(pageModule);
    await stale.promise;

    expect(states).toEqual([{ status: 'ready', module: currentModule, error: null }]);
  });
});

describe('已解析模块的缓存', () => {
  afterEach(() => clearPageModuleCache());

  test('没加载过的 loader 起点仍是 loading', () => {
    const loader = () => Promise.resolve(pageModule);
    expect(cachedPageModule(loader)).toBeNull();
    expect(initialPageModuleState(loader)).toEqual(PAGE_MODULE_LOADING);
  });

  test('加载成功后同一个 loader 的起点直接是 ready', async () => {
    const { apply } = recorder();
    const loader = () => Promise.resolve(pageModule);

    requestPageModule(loader, apply);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(cachedPageModule(loader)).toBe(pageModule);
    expect(initialPageModuleState(loader)).toEqual({
      status: 'ready',
      module: pageModule,
      error: null,
    });
  });

  test('失败的 loader 不进缓存', async () => {
    const { apply } = recorder();
    const loader = () => Promise.reject(new Error('chunk load failed'));

    requestPageModule(loader, apply);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(cachedPageModule(loader)).toBeNull();
  });

  test('缓存按 loader 区分，别的路由拿不到', async () => {
    const { apply } = recorder();
    const loader = () => Promise.resolve(pageModule);
    const other = () => Promise.resolve({});

    requestPageModule(loader, apply);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(cachedPageModule(other)).toBeNull();
  });
});

describe('syncPageModuleState（usePageModule 的 effect 主体）', () => {
  afterEach(() => clearPageModuleCache());

  /** 组件状态的最小替身：接住值或更新函数，行为与 React 的 setState 一致。 */
  function stateBox(initial: PageModuleState) {
    let state = initial;
    const renders: PageModuleState[] = [];
    return {
      get current() {
        return state;
      },
      renders,
      apply: (update: PageModuleState | ((prev: PageModuleState) => PageModuleState)) => {
        const next = typeof update === 'function' ? update(state) : update;
        if (next === state) return;
        state = next;
        renders.push(next);
      },
    };
  }

  test('缓存在 render 与 effect 之间才落地：effect 把状态校准到 ready，不再停在 loading', async () => {
    const gate = deferred<PageModule>();
    const loader = () => gate.promise;

    // 第一次进这个页面：模块还没下完就切走，取消掉。
    const cancel = requestPageModule(loader, () => undefined);
    cancel();

    // 第二次 render：缓存还是空的，状态从 loading 起步。
    const box = stateBox(initialPageModuleState(loader));
    expect(box.current).toEqual(PAGE_MODULE_LOADING);

    // render 之后、effect 之前，第一次那个已取消的请求落地并写进了缓存。
    gate.resolve(pageModule);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(cachedPageModule(loader)).toBe(pageModule);

    const cleanup = syncPageModuleState(loader, box.apply);

    expect(cleanup).toBeUndefined();
    expect(box.current).toEqual({ status: 'ready', module: pageModule, error: null });
  });

  test('状态已经对上同一个模块：不再写一次 state，避免多余的重渲染', async () => {
    const loader = () => Promise.resolve(pageModule);
    requestPageModule(loader, () => undefined);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const box = stateBox(initialPageModuleState(loader));
    expect(box.current).toEqual({ status: 'ready', module: pageModule, error: null });

    syncPageModuleState(loader, box.apply);

    expect(box.renders).toEqual([]);
  });

  test('没命中缓存时照常发请求，并把取消函数交回 effect', async () => {
    const gate = deferred<PageModule>();
    const loader = () => gate.promise;
    const box = stateBox({ status: 'error', module: null, error: new Error('boom') });

    const cleanup = syncPageModuleState(loader, box.apply);

    expect(box.current).toEqual(PAGE_MODULE_LOADING);
    expect(typeof cleanup).toBe('function');

    cleanup?.();
    gate.resolve(pageModule);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // 取消之后不再回写状态，但缓存仍然落地——正是上面那条用例要兜的时序。
    expect(box.current).toEqual(PAGE_MODULE_LOADING);
    expect(cachedPageModule(loader)).toBe(pageModule);
  });
});

describe('toPageModuleError', () => {
  test('keeps the original Error instance', () => {
    const failure = new Error('nope');
    expect(toPageModuleError(failure)).toBe(failure);
  });

  test('stringifies other reasons', () => {
    expect(toPageModuleError({ code: 1 }).message).toBe('[object Object]');
  });
});

describe('requestPageModule 的 i18n 前置条件', () => {
  afterEach(() => setPageModulePrerequisite(null));

  test('前置条件未就绪时不进入 ready', async () => {
    const { states, apply } = recorder();
    const bundle = deferred<void>();
    setPageModulePrerequisite(() => bundle.promise);

    requestPageModule(() => Promise.resolve(pageModule), apply);
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toEqual([]);

    bundle.resolve(undefined);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(states).toEqual([{ status: 'ready', module: pageModule, error: null }]);
  });

  test('前置条件失败不拖垮页面', async () => {
    const { states, apply } = recorder();
    setPageModulePrerequisite(() => Promise.reject(new Error('locale chunk 404')));

    requestPageModule(() => Promise.resolve(pageModule), apply);
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(states).toEqual([{ status: 'ready', module: pageModule, error: null }]);
  });
});

describe('PAGE_MODULE_LOADING', () => {
  test('starts without a module or error', () => {
    expect(PAGE_MODULE_LOADING).toEqual({ status: 'loading', module: null, error: null });
  });
});

const localesDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/shared/src/i18n/locales'
);

describe('page load fallback copy', () => {
  test('is translated in all locales', async () => {
    for (const locale of ['en_US', 'zh_CN', 'ja_JP']) {
      const json = (await Bun.file(path.join(localesDir, `${locale}.json`)).json()) as {
        translation: { common: Record<string, unknown> };
      };
      for (const key of ['pageLoadFailed', 'pageLoadFailedHint', 'retry']) {
        expect(typeof json.translation.common[key]).toBe('string');
      }
    }
  });
});
