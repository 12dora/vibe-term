import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PAGE_MODULE_LOADING,
  type PageModule,
  type PageModuleState,
  requestPageModule,
  setPageModulePrerequisite,
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
