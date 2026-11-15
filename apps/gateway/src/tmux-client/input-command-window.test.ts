import { describe, expect, test } from 'bun:test';
import {
  INPUT_PENDING_MAX_BYTES,
  InputCommandWindow,
  InputQueueFullError,
} from './input-command-window';
import {
  SEND_KEYS_HEX_CHUNK_BYTES,
  buildSendKeysArgv,
  buildSendKeysCommands,
  parseSendKeysHexArgv,
} from './input-encoder';
import { InputSubmission } from './input-submission';

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
  test('cancellation settles pending jobs before a slot frees and preserves ordinary jobs', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const active = window.enqueue([['active']], h.execute);
    const submission = new InputSubmission(() => true);
    const mouse = window.enqueue([['mouse']], h.execute, submission);
    const key = window.enqueue([['key']], h.execute);
    expect(submission.cancel()).toBe(true);
    await mouse;
    expect(h.started).toEqual(['active']);
    h.replies[0].resolve();
    await active;
    expect(h.started).toEqual(['active', 'key']);
    h.replies[1].resolve();
    await key;
  });

  test('checks submission validity again immediately before running a queued job', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    let current = true;
    const active = window.enqueue([['active']], h.execute);
    const stale = window.enqueue([['stale']], h.execute, new InputSubmission(() => current));
    current = false;
    h.replies[0].resolve();
    await Promise.all([active, stale]);
    expect(h.started).toEqual(['active']);
  });

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

  test('rejects the newest payload when pending entries exceed 256', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const queued: Promise<void>[] = [];
    for (let i = 0; i < 256; i += 1) {
      queued.push(window.enqueue([[`c${i}`]], h.execute));
    }
    await expect(window.enqueue([['overflow']], h.execute)).rejects.toBeInstanceOf(
      InputQueueFullError
    );
    window.dispose('done');
    await Promise.allSettled(queued);
  });

  test('a 257-chunk paste on an empty window is accepted', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const commands = buildSendKeysCommands('%1', new Uint8Array(257 * SEND_KEYS_HEX_CHUNK_BYTES));
    expect(commands).toHaveLength(257);
    const accepted = window.enqueue(commands, h.execute);
    await expect(window.enqueue([['overflow']], h.execute)).rejects.toBeInstanceOf(
      InputQueueFullError
    );
    window.dispose('done');
    await expect(accepted).rejects.toThrow('done');
  });

  test('a 1 MiB paste fits the argv byte budget on an empty window', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const commands = buildSendKeysCommands('%1', new Uint8Array(1024 * 1024));
    expect(commands).toHaveLength((1024 * 1024) / SEND_KEYS_HEX_CHUNK_BYTES);
    const accepted = window.enqueue(commands, h.execute);
    window.dispose('done');
    await expect(accepted).rejects.toThrow('done');
  });

  test('rejects the newest payload when pending bytes exceed the argv budget', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const chunk = 'x'.repeat(64 * 1024);
    const queued: Promise<void>[] = [];
    for (let i = 0; i < INPUT_PENDING_MAX_BYTES / (64 * 1024); i += 1) {
      queued.push(window.enqueue([[chunk]], h.execute));
    }
    await expect(window.enqueue([['y']], h.execute)).rejects.toMatchObject({
      code: 'input_queue_full',
    });
    window.dispose('done');
    await Promise.allSettled(queued);
  });
});

function keys(paneId: string, bytes: Uint8Array | number | string): string[][] {
  const payload =
    typeof bytes === 'number'
      ? new Uint8Array(bytes).fill(0x61)
      : typeof bytes === 'string'
        ? new TextEncoder().encode(bytes)
        : bytes;
  return buildSendKeysCommands(paneId, payload);
}

function hexPayload(argv: string[]): string[] {
  return parseSendKeysHexArgv(argv)?.hex ?? [];
}

function argvBytes(argv: readonly string[]): number {
  let n = 0;
  for (const part of argv) n += part.length;
  return n;
}

describe('InputCommandWindow send-keys coalescing', () => {
  test('merges waiting send-keys -H for the same pane and preserves byte order', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const first = window.enqueue(keys('%1', 'A'), h.execute);
    const second = window.enqueue(keys('%1', 'B'), h.execute);
    expect(h.started).toEqual([]);
    expect(window.pendingJobCount).toBe(1);
    expect(window.pendingByteCount).toBe(argvBytes(buildSendKeysArgv('%1', ['41', '42'])));
    window.dispose('done');
    await expect(Promise.all([first, second])).rejects.toThrow('done');
  });

  test('merges multiple commands from one enqueue into a single waiting job', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const queued = window.enqueue(
      [
        buildSendKeysArgv('%1', ['41']),
        buildSendKeysArgv('%1', ['42']),
        buildSendKeysArgv('%1', ['43']),
      ],
      h.execute
    );
    expect(window.pendingJobCount).toBe(1);
    expect(window.pendingByteCount).toBe(argvBytes(buildSendKeysArgv('%1', ['41', '42', '43'])));
    window.dispose('done');
    await expect(queued).rejects.toThrow('done');
  });

  test('merged argv decodes to the exact concatenation of the original payloads', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const sgr = '\x1b[<35;21;2M';
    const utf8 = '中';
    const hold = window.enqueue([['hold']], h.execute);
    const first = window.enqueue(keys('%1', sgr), h.execute);
    const second = window.enqueue(keys('%1', utf8), h.execute);
    expect(window.pendingJobCount).toBe(1);
    h.replies[0].resolve();
    await hold;
    await flush();
    expect(h.started).toHaveLength(2);
    const startedArgv = h.started[1].split(' ');
    const decoded = Uint8Array.from(hexPayload(startedArgv), (token) => Number.parseInt(token, 16));
    expect(decoded).toEqual(new TextEncoder().encode(`${sgr}${utf8}`));
    h.replies[1].resolve();
    await Promise.all([first, second]);
  });

  test('does not merge across another pane waiting in between', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const a = window.enqueue(keys('%1', 'A'), h.execute);
    const b = window.enqueue(keys('%2', 'B'), h.execute);
    const c = window.enqueue(keys('%1', 'C'), h.execute);
    expect(window.pendingJobCount).toBe(3);
    window.dispose('done');
    await Promise.allSettled([a, b, c]);
  });

  test('does not merge non-send-keys commands or mismatched submissions', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const first = window.enqueue(keys('%1', 'A'), h.execute);
    const other = window.enqueue([['refresh']], h.execute);
    const left = new InputSubmission(() => true);
    const right = new InputSubmission(() => true);
    const mismatched = window.enqueue(keys('%1', 'B'), h.execute, left);
    const later = window.enqueue(keys('%1', 'C'), h.execute, right);
    expect(window.pendingJobCount).toBe(4);
    window.dispose('done');
    await Promise.allSettled([first, other, mismatched, later]);
  });

  test('merges only up to SEND_KEYS_HEX_CHUNK_BYTES of payload', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const almost = window.enqueue(keys('%1', SEND_KEYS_HEX_CHUNK_BYTES - 1), h.execute);
    const one = window.enqueue(keys('%1', 1), h.execute);
    expect(window.pendingJobCount).toBe(1);
    const overflow = new InputCommandWindow(() => 0);
    const overA = overflow.enqueue(keys('%1', SEND_KEYS_HEX_CHUNK_BYTES), h.execute);
    const overB = overflow.enqueue(keys('%1', 1), h.execute);
    expect(overflow.pendingJobCount).toBe(2);
    window.dispose('done');
    overflow.dispose('done');
    await Promise.allSettled([almost, one, overA, overB]);
  });

  test('cancel of a merged submission settles every original job and restores pendingBytes', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const hold = window.enqueue([['hold']], h.execute);
    const submission = new InputSubmission(() => true);
    const first = window.enqueue(keys('%1', 'A'), h.execute, submission);
    const second = window.enqueue(keys('%1', 'B'), h.execute, submission);
    expect(window.pendingJobCount).toBe(1);
    expect(window.pendingByteCount).toBeGreaterThan(0);
    expect(submission.cancel()).toBe(true);
    await Promise.all([first, second]);
    expect(window.pendingJobCount).toBe(0);
    expect(window.pendingByteCount).toBe(0);
    expect(h.started).toEqual(['hold']);
    h.replies[0].resolve();
    await hold;
  });

  test('merged jobs resolve together when the surviving execute succeeds', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const hold = window.enqueue([['hold']], h.execute);
    const first = window.enqueue(keys('%1', 'A'), h.execute);
    const second = window.enqueue(keys('%1', 'B'), h.execute);
    expect(window.pendingJobCount).toBe(1);
    h.replies[0].resolve();
    await hold;
    await flush();
    expect(h.started).toHaveLength(2);
    expect(hexPayload(h.started[1].split(' '))).toEqual(['41', '42']);
    h.replies[1].resolve();
    await Promise.all([first, second]);
  });

  test('merged jobs reject together when the surviving execute fails', async () => {
    const window = new InputCommandWindow(() => 1);
    const h = deferredExecutor();
    const hold = window.enqueue([['hold']], h.execute);
    const first = window.enqueue(keys('%1', 'A'), h.execute);
    const second = window.enqueue(keys('%1', 'B'), h.execute);
    h.replies[0].resolve();
    await hold;
    await flush();
    const settled = Promise.all([first, second]);
    h.replies[1].reject(new Error('send failed'));
    await expect(settled).rejects.toThrow('send failed');
  });

  test('pendingBytes counts a merged argv once including a single command prefix', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const firstCmd = keys('%1', 'A')[0];
    const merged = buildSendKeysArgv('%1', ['41', '42']);
    const first = window.enqueue([firstCmd], h.execute);
    expect(window.pendingByteCount).toBe(argvBytes(firstCmd));
    const second = window.enqueue(keys('%1', 'B'), h.execute);
    expect(window.pendingJobCount).toBe(1);
    expect(window.pendingByteCount).toBe(argvBytes(merged));
    expect(window.pendingByteCount).toBeLessThan(
      argvBytes(firstCmd) + argvBytes(keys('%1', 'B')[0])
    );
    window.dispose('done');
    await Promise.allSettled([first, second]);
  });

  test('a merge that adds no entry is accepted on a full window', async () => {
    const window = new InputCommandWindow(() => 0);
    const h = deferredExecutor();
    const queued: Promise<void>[] = [];
    for (let i = 0; i < 255; i += 1) {
      queued.push(window.enqueue([[`c${i}`]], h.execute));
    }
    queued.push(window.enqueue(keys('%1', 'A'), h.execute));
    expect(window.pendingJobCount).toBe(256);
    const merged = window.enqueue(keys('%1', 'B'), h.execute);
    expect(window.pendingJobCount).toBe(256);
    await expect(window.enqueue([['overflow']], h.execute)).rejects.toBeInstanceOf(
      InputQueueFullError
    );
    window.dispose('done');
    await Promise.allSettled([...queued, merged]);
  });
});
