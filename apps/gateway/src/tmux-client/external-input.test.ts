import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';
import { sendExternalInput } from './external-input';
import { InputCommandWindow, InputQueueFullError } from './input-command-window';
import { PIPELINED_INPUT_TIMEOUT_MS, SEND_KEYS_HEX_CHUNK_BYTES } from './input-encoder';

function harness() {
  let current = true;
  let acknowledged = false;
  let settled = false;
  const observations: { acknowledged: boolean; settled: boolean }[] = [];
  const queue = new ControlModeCommandQueue();
  const window = new InputCommandWindow(() => 4);
  const parser = createControlModeParser({
    onOutput: () => observations.push({ acknowledged, settled }),
    onNotification: () => {},
    onExit: () => {},
    onBlockEnd: (block) => queue.handleBlock(block),
  });
  const writes: string[] = [];
  return {
    queue,
    observations,
    writes,
    invalidate: () => {
      current = false;
    },
    acknowledged: () => acknowledged,
    push: (text: string) => parser.push(new TextEncoder().encode(text)),
    send: (size = 1, run?: () => Promise<void>) => {
      const result = sendExternalInput(
        {
          queue,
          window,
          write: run ? undefined : (text) => writes.push(text),
          isCurrent: () => current,
          run: run ?? (() => Promise.resolve()),
          onError: () => {},
        },
        '%1',
        new Uint8Array(size).fill(65),
        () => {
          acknowledged = true;
        }
      );
      void result.then(
        () => {
          settled = true;
        },
        () => {}
      );
      return result;
    },
  };
}

function reply(id: number, error = false): string {
  return `%begin 1 ${id} 1\n%${error ? 'error' : 'end'} 1 ${id} 1\n`;
}

describe('external input synchronous acknowledgement', () => {
  test('real parser observes ack before redraw in the same stdout chunk and before promises settle', async () => {
    const h = harness();
    const completion = h.send();
    h.push(`${reply(1)}%output %1 redraw\n`);
    expect(h.observations).toEqual([{ acknowledged: true, settled: false }]);
    await completion;
    h.queue.dispose();
  });

  test('ack waits for every payload command, including commands queued outside the window', async () => {
    const h = harness();
    const completion = h.send(256 * 5);
    expect(h.writes).toHaveLength(4);
    h.push(reply(1) + reply(2) + reply(3) + reply(4));
    expect(h.acknowledged()).toBe(false);
    await Bun.sleep(0);
    expect(h.writes).toHaveLength(5);
    h.push(`${reply(5)}%output %1 redraw\n`);
    expect(h.observations).toEqual([{ acknowledged: true, settled: false }]);
    await completion;
    h.queue.dispose();
  });

  test('an earlier error never acknowledges the payload when its final command succeeds in the same chunk', async () => {
    const h = harness();
    const completion = h.send(512);
    h.push(reply(1, true) + reply(2));
    expect(h.acknowledged()).toBe(false);
    await expect(completion).rejects.toThrow('tmux control command failed');
    h.queue.dispose();
  });

  test('transport invalidation suppresses a late successful control acknowledgement', async () => {
    const h = harness();
    const completion = h.send();
    h.invalidate();
    h.push(reply(1));
    await completion;
    expect(h.acknowledged()).toBe(false);
    h.queue.dispose();
  });

  test('transport invalidation suppresses a late successful spawn acknowledgement', async () => {
    const h = harness();
    const deferred = Promise.withResolvers<void>();
    const completion = h.send(1, () => deferred.promise);
    h.invalidate();
    deferred.resolve();
    await completion;
    expect(h.acknowledged()).toBe(false);
    h.queue.dispose();
  });

  test('queue-full paste does not write or call onError', async () => {
    const window = new InputCommandWindow(() => 0);
    const writes: string[] = [];
    const errors: Error[] = [];
    const queue = new ControlModeCommandQueue();
    const queued: Promise<void>[] = [];
    for (let i = 0; i < 256; i += 1) {
      queued.push(window.enqueue([[`c${i}`]], () => Promise.resolve()));
    }
    const result = sendExternalInput(
      {
        queue,
        window,
        write: (text) => writes.push(text),
        isCurrent: () => true,
        run: () => Promise.resolve(),
        onError: (error) => errors.push(error),
      },
      '%1',
      new Uint8Array(SEND_KEYS_HEX_CHUNK_BYTES)
    );
    await expect(result).rejects.toBeInstanceOf(InputQueueFullError);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    window.dispose('done');
    queue.dispose();
    await Promise.allSettled(queued);
  });

  test('failed transform and synchronous write failure never trigger the queue acknowledgement', async () => {
    const h = harness();
    let acknowledgements = 0;
    const failedTransform = h.queue.execute(() => {}, 'bad-transform', {
      onAck: () => acknowledgements++,
      transform: () => {
        throw new Error('invalid response');
      },
    });
    h.push(reply(1));
    await expect(failedTransform).rejects.toThrow('invalid response');
    const failedWrite = h.queue.execute(
      () => {
        throw new Error('closed pipe');
      },
      'bad-write',
      { onAck: () => acknowledgements++, transform: () => undefined }
    );
    await expect(failedWrite).rejects.toThrow('closed pipe');
    expect(acknowledgements).toBe(0);
    h.queue.dispose();
  });
});

interface FakeExecuteCall {
  command: string;
  poisonOnTimeout?: boolean;
  sample?: boolean;
  timeoutMs?: number;
}

function fakeQueue(replies: Array<Promise<unknown> | Error> = []) {
  const calls: FakeExecuteCall[] = [];
  let index = 0;
  const queue = {
    execute: (
      _write: (command: string) => void,
      command: string,
      options: {
        poisonOnTimeout?: boolean;
        sample?: boolean;
        timeoutMs?: number;
        onAck?: () => void;
        transform: () => undefined;
      }
    ) => {
      calls.push({
        command,
        poisonOnTimeout: options.poisonOnTimeout,
        sample: options.sample,
        timeoutMs: options.timeoutMs,
      });
      const reply = replies[index];
      index += 1;
      if (reply instanceof Error) return Promise.reject(reply);
      return (reply ?? Promise.resolve(undefined)).then((value) => {
        options.onAck?.();
        return value;
      });
    },
  };
  return { queue, calls };
}

describe('external input timeout and coalescing', () => {
  test('input execute never poisons the control queue on timeout', async () => {
    const timeout = new Error('tmux control command timed out: send-keys');
    const fake = fakeQueue([timeout]);
    const errors: Error[] = [];
    const result = sendExternalInput(
      {
        queue: fake.queue as unknown as ControlModeCommandQueue,
        write: () => {},
        isCurrent: () => true,
        run: () => Promise.resolve(),
        onError: (error) => errors.push(error),
      },
      '%1',
      new Uint8Array([0x41])
    );
    await expect(result).rejects.toThrow('timed out');
    expect(fake.calls).toEqual([
      {
        command: 'send-keys -H -t %1 41',
        poisonOnTimeout: false,
        sample: true,
        timeoutMs: undefined,
      },
    ]);
    expect(errors).toEqual([timeout]);
  });

  test('resolves function timeoutMs at execute time, not enqueue time', async () => {
    const blocker = Promise.withResolvers<void>();
    const fake = fakeQueue([blocker.promise, Promise.resolve()]);
    const window = new InputCommandWindow(() => 1);
    let timeoutMs = 11;
    const transport = {
      queue: fake.queue as unknown as ControlModeCommandQueue,
      window,
      write: () => {},
      isCurrent: () => true,
      run: () => Promise.resolve(),
      onError: () => {},
      timeoutMs: () => timeoutMs,
    };
    const first = sendExternalInput(transport, '%1', new Uint8Array([0x41]));
    const second = sendExternalInput(transport, '%1', new Uint8Array([0x42]));
    timeoutMs = 22;
    blocker.resolve();
    await Promise.all([first, second]);
    expect(fake.calls.map((call) => call.timeoutMs)).toEqual([11, 22]);
    expect(fake.calls.every((call) => call.poisonOnTimeout === false)).toBe(true);
    window.dispose('done');
  });

  test('multi-chunk input keeps at least the pipelined timeout', async () => {
    const fake = fakeQueue();
    const result = sendExternalInput(
      {
        queue: fake.queue as unknown as ControlModeCommandQueue,
        write: () => {},
        isCurrent: () => true,
        run: () => Promise.resolve(),
        onError: () => {},
        timeoutMs: () => 1_000,
      },
      '%1',
      new Uint8Array(SEND_KEYS_HEX_CHUNK_BYTES + 1).fill(0x41)
    );
    await result;
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((call) => call.timeoutMs)).toEqual([
      PIPELINED_INPUT_TIMEOUT_MS,
      PIPELINED_INPUT_TIMEOUT_MS,
    ]);
  });
});
