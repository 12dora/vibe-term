import { describe, expect, test } from 'bun:test';
import { InputCommandWindow } from './input-command-window';

function deferredExecutor() {
  const started: string[] = [];
  const replies: ReturnType<typeof Promise.withResolvers<void>>[] = [];
  return {
    started,
    replies,
    execute: (argv: string[]) => {
      started.push(argv.join(' '));
      const reply = Promise.withResolvers<void>();
      replies.push(reply);
      return reply.promise;
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('InputCommandWindow', () => {
  test('six payloads share four slots and each completion starts exactly the next command', async () => {
    const window = new InputCommandWindow(() => 4);
    const h = deferredExecutor();
    const inputs = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => window.enqueue([[key]], h.execute));
    expect(h.started).toEqual(['a', 'b', 'c', 'd']);
    for (let i = 0; i < 6; i += 1) {
      h.replies[i].resolve();
      await flush();
      expect(h.started).toEqual(['a', 'b', 'c', 'd', 'e', 'f'].slice(0, i + 5));
      expect(h.started.length - (i + 1)).toBeLessThanOrEqual(4);
    }
    await Promise.all(inputs);
  });

  test('appends a whole payload before pumping, including reentrant submissions', async () => {
    const window = new InputCommandWindow(() => 4);
    const h = deferredExecutor();
    let next: Promise<void> | undefined;
    const paste = window.enqueue([['a1'], ['a2'], ['a3'], ['a4'], ['a5']], (argv) => {
      if (argv[0] === 'a1') next = window.enqueue([['b']], h.execute);
      return h.execute(argv);
    });
    expect(h.started).toEqual(['a1', 'a2', 'a3', 'a4']);
    for (let i = 0; i < 6; i += 1) {
      h.replies[i].resolve();
      await flush();
    }
    expect(h.started).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'b']);
    await Promise.all([paste, next]);
  });

  test('a synchronous executor error rejects its payload and releases the slot', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const failed = window.enqueue([['bad']], () => {
      throw new Error('write failed');
    });
    const next = window.enqueue([['next']], h.execute);
    await expect(failed).rejects.toThrow('write failed');
    expect(h.started).toEqual(['next']);
    h.replies[0].resolve();
    await next;
  });

  test('dispose rejects pending and future jobs; late completions cannot start them', async () => {
    const window = new InputCommandWindow(() => 4);
    const h = deferredExecutor();
    const active = window.enqueue([['a'], ['b'], ['c'], ['d']], h.execute);
    const pending = window.enqueue([['e'], ['f']], h.execute);
    window.dispose('disconnected');
    window.dispose('ignored');
    expect(window.disposed).toBe(true);
    await expect(pending).rejects.toThrow('disconnected');
    await expect(window.enqueue([['g']], h.execute)).rejects.toThrow('disconnected');
    for (const reply of h.replies) reply.resolve();
    await active;
    expect(h.started).toEqual(['a', 'b', 'c', 'd']);
  });

  test('serial fallback preserves chunk and payload order across a failure', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const paste = window.enqueue([['a1'], ['a2']], h.execute);
    const key = window.enqueue([['b']], h.execute);
    expect(h.started).toEqual(['a1']);
    h.replies[0].reject(new Error('spawn failed'));
    await expect(paste).rejects.toThrow('spawn failed');
    expect(h.started).toEqual(['a1', 'a2']);
    h.replies[1].resolve();
    await flush();
    expect(h.started).toEqual(['a1', 'a2', 'b']);
    h.replies[2].resolve();
    await key;
  });

  test('empty payload resolves without occupying a slot', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    await window.enqueue([], h.execute);
    expect(h.started).toEqual([]);
  });
});
