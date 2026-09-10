import { describe, expect, test } from 'bun:test';

import { ControlModeCommandQueue, capturePaneFrameAtControlBarrier } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';

const encoder = new TextEncoder();

function createHarness() {
  const writes: string[] = [];
  const events: string[] = [];
  const queue = new ControlModeCommandQueue();
  const parser = createControlModeParser({
    onOutput: () => events.push('output'),
    onNotification: () => events.push('notification'),
    onExit: () => {},
    onBlockBegin: () => queue.nextBlockIsLiteral(),
    onBlockEnd: (block) => {
      queue.handleBlock(block);
      events.push('block-end');
    },
  });
  return { writes, events, queue, parser };
}

describe('control-mode atomic capture', () => {
  test('aligns command blocks and keeps notification-looking screen lines literal', async () => {
    const { writes, events, queue, parser } = createHarness();
    const capturePromise = capturePaneFrameAtControlBarrier(
      queue,
      (command) => writes.push(command),
      '%1',
      50,
      () => events.push('barrier')
    );
    expect(writes).toHaveLength(3);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n80|24|0|3|4|200|1|0|0|1|0\n%end 1 2 0\n' +
          '%begin 1 3 0\n%output this is terminal text\n%window-add also terminal text\n' +
          '%end 1 3 0\n' +
          '%begin 1 4 0\nold history line\n%end 1 4 0\n%output %1 live\n'
      )
    );

    const capture = await capturePromise;
    expect(capture).toEqual({
      text: '%output this is terminal text\n%window-add also terminal text',
      historyText: 'old history line',
      cols: 80,
      rows: 24,
      cursorX: 3,
      cursorY: 4,
      alternateScreen: false,
      historySize: 200,
      modes: {
        mouseStandard: true,
        mouseButton: false,
        mouseAll: false,
        mouseSgr: true,
        mouseUtf8: false,
      },
    });
    expect(events).toEqual(['block-end', 'barrier', 'block-end', 'block-end', 'output']);
    expect(writes[1]).toBe('capture-pane -p -e -J -N -t %1\n');
    expect(writes[2]).toBe('capture-pane -p -e -J -N -t %1 -S -50 -E -1\n');
    queue.dispose();
  });

  test('preserves blank screen rows inside literal capture blocks', async () => {
    const { writes, queue, parser } = createHarness();
    const capturePromise = capturePaneFrameAtControlBarrier(
      queue,
      (command) => writes.push(command),
      '%1',
      0,
      () => {}
    );
    expect(writes).toHaveLength(2);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n80|24|0|0|0|0|0|0|0|0|0\n%end 1 2 0\n' +
          '%begin 1 3 0\nfirst\n\n\nfourth\n%end 1 3 0\n'
      )
    );
    const capture = await capturePromise;
    expect(capture.text).toBe('first\n\n\nfourth');
    expect(capture.historyText).toBeNull();
    queue.dispose();
  });
});

describe('control command latency sampling', () => {
  function createQueue() {
    const samples: number[] = [];
    let clock = 0;
    const queue = new ControlModeCommandQueue(undefined, {
      onSample: (rttMs) => samples.push(rttMs),
      now: () => clock,
    });
    const block = (lines: string[] = [], isError = false) => ({ args: '', isError, lines });
    return {
      samples,
      queue,
      block,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  test('times write→%end for sampled commands only', () => {
    const { samples, queue, block, advance } = createQueue();
    void queue.execute(() => {}, 'send-keys -t %1 a', { sample: true, transform: () => undefined });
    advance(7);
    queue.handleBlock(block());
    void queue.execute(() => {}, 'capture-pane -p', { transform: () => undefined });
    advance(500);
    queue.handleBlock(block());
    expect(samples).toEqual([7]);
  });

  test('skips commands written while another is still pending', () => {
    const { samples, queue, block, advance } = createQueue();
    void queue.execute(() => {}, 'send-keys -t %1 a', { sample: true, transform: () => undefined });
    void queue.execute(() => {}, 'send-keys -t %1 b', { sample: true, transform: () => undefined });
    advance(4);
    queue.handleBlock(block());
    advance(100);
    queue.handleBlock(block());
    expect(samples).toEqual([4]);
  });

  test('drops samples for error blocks, timeouts and disposed commands', async () => {
    const { samples, queue, block, advance } = createQueue();
    void queue
      .execute(() => {}, 'send-keys -t %1 a', { sample: true, transform: () => undefined })
      .catch(() => {});
    advance(3);
    queue.handleBlock(block(['no current client'], true));
    void queue
      .execute(() => {}, 'send-keys -t %1 timeout', {
        sample: true,
        timeoutMs: 20,
        poisonOnTimeout: false,
        transform: () => undefined,
      })
      .catch(() => {});
    await Bun.sleep(50);
    void queue
      .execute(() => {}, 'send-keys -t %1 b', { sample: true, transform: () => undefined })
      .catch(() => {});
    queue.dispose('closed');
    expect(samples).toEqual([]);
  });

  test('timeout poisons the queue by default', async () => {
    let poisoned = 0;
    const queue = new ControlModeCommandQueue(() => {
      poisoned += 1;
    });
    const first = queue
      .execute(() => {}, 'cmd-a', { timeoutMs: 20, transform: () => 'a' })
      .then(
        () => {
          throw new Error('cmd-a should time out');
        },
        (error: Error) => error
      );
    const second = queue
      .execute(() => {}, 'cmd-b', { timeoutMs: 5_000, transform: () => 'b' })
      .then(
        () => {
          throw new Error('cmd-b should time out');
        },
        (error: Error) => error
      );
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError.message).toMatch(/timed out/);
    expect(secondError.message).toMatch(/timed out/);
    expect(poisoned).toBe(1);
    await expect(queue.execute(() => {}, 'cmd-c', { transform: () => 'c' })).rejects.toThrow(
      /closed/
    );
  });

  test('poisonOnTimeout false rejects only that command and leaves the queue intact', async () => {
    let poisoned = 0;
    const queue = new ControlModeCommandQueue(() => {
      poisoned += 1;
    });
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      sample: true,
      transform: () => 'probe',
    });
    const user = queue.execute(() => {}, 'send-keys', {
      timeoutMs: 5_000,
      transform: () => 'user',
    });
    await expect(probe).rejects.toThrow(/timed out/);
    expect(poisoned).toBe(0);
    expect(queue.busy).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['probe-out'] })).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: [] })).toBe(true);
    await expect(user).resolves.toBe('user');
    const next = queue.execute(() => {}, 'send-keys 2', { transform: () => 'ok' });
    expect(queue.handleBlock({ args: '', isError: false, lines: [] })).toBe(true);
    await expect(next).resolves.toBe('ok');
    expect(poisoned).toBe(0);
    queue.dispose();
  });

  test('poisonOnTimeout false drops a solo timed-out command so the queue is idle again', async () => {
    let poisoned = 0;
    const queue = new ControlModeCommandQueue(() => {
      poisoned += 1;
    });
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => undefined,
    });
    await expect(probe).rejects.toThrow(/timed out/);
    expect(queue.busy).toBe(false);
    expect(poisoned).toBe(0);
    const user = queue.execute(() => {}, 'send-keys', { transform: () => 'ok' });
    expect(queue.handleBlock({ args: '', isError: false, lines: [] })).toBe(true);
    await expect(user).resolves.toBe('ok');
    queue.dispose();
  });

  test('records nothing when no sampler is wired', () => {
    const queue = new ControlModeCommandQueue();
    void queue.execute(() => {}, 'send-keys -t %1 a', { sample: true, transform: () => undefined });
    expect(queue.busy).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: [] })).toBe(true);
    expect(queue.busy).toBe(false);
  });
});
