import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';
import { sendExternalInput } from './external-input';
import { InputCommandWindow } from './input-command-window';

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
