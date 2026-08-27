import { describe, expect, test } from 'bun:test';
import { defaultScheduler } from './ctl';

describe('defaultScheduler.sleep', () => {
  test('removes the abort listener when the timer fires', async () => {
    const scheduler = defaultScheduler();
    const ac = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'abort') added.push(listener);
      return origAdd(type, listener, options);
    }) as AbortSignal['addEventListener'];
    ac.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === 'abort') removed.push(listener);
      return origRemove(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    await scheduler.sleep(5, ac.signal);
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
    ac.abort();
  });

  test('removes the abort listener on the abort path', async () => {
    const scheduler = defaultScheduler();
    const ac = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'abort') added.push(listener);
      return origAdd(type, listener, options);
    }) as AbortSignal['addEventListener'];
    ac.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (type === 'abort') removed.push(listener);
      return origRemove(type, listener, options);
    }) as AbortSignal['removeEventListener'];

    const pending = scheduler.sleep(60_000, ac.signal);
    ac.abort();
    await expect(pending).rejects.toBeDefined();
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
});
