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
    onBlockBegin: (args) => queue.nextBlockIsLiteral(args),
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
      transform: () => 'probe',
    });
    await expect(probe).rejects.toThrow(/timed out/);
    expect(queue.busy).toBe(false);
    expect(poisoned).toBe(0);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['vibeterm-lat'] })).toBe(true);
    expect(queue.busy).toBe(false);
    const user = queue.execute(() => {}, 'send-keys', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.handleBlock({ args: '', isError: false, lines: ['user-out'] })).toBe(true);
    await expect(user).resolves.toBe('user-out');
    expect(poisoned).toBe(0);
    queue.dispose();
  });

  test('orphan late block does not leak the next command literal flag', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    await expect(probe).rejects.toThrow(/timed out/);
    expect(queue.nextBlockIsLiteral()).toBe(false);
    const capture = queue.execute(() => {}, 'capture-pane -p', {
      literal: true,
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral()).toBe(false);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['vibeterm-lat'] })).toBe(true);
    expect(queue.nextBlockIsLiteral()).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['pane text'] })).toBe(true);
    await expect(capture).resolves.toBe('pane text');
    queue.dispose();
  });

  test('dispose and poison drop the orphan counter so a late block is not swallowed after reconnect', async () => {
    const disposed = new ControlModeCommandQueue();
    const probe = disposed.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => undefined,
    });
    await expect(probe).rejects.toThrow(/timed out/);
    disposed.dispose();
    expect(disposed.handleBlock({ args: '', isError: false, lines: ['vibeterm-lat'] })).toBe(false);

    let poisoned = 0;
    const live = new ControlModeCommandQueue(() => {
      poisoned += 1;
    });
    const first = live.execute(() => {}, 'cmd-a', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'a',
    });
    await expect(first).rejects.toThrow(/timed out/);
    const boom = live.execute(() => {}, 'cmd-b', { timeoutMs: 20, transform: () => 'b' });
    await expect(boom).rejects.toThrow(/timed out/);
    expect(poisoned).toBe(1);
    expect(live.handleBlock({ args: '', isError: false, lines: ['late'] })).toBe(false);
  });

  test('records nothing when no sampler is wired', () => {
    const queue = new ControlModeCommandQueue();
    void queue.execute(() => {}, 'send-keys -t %1 a', { sample: true, transform: () => undefined });
    expect(queue.busy).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: [] })).toBe(true);
    expect(queue.busy).toBe(false);
  });

  test('expired orphan does not swallow the next command block', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    await expect(probe).rejects.toThrow(/timed out/);
    await Bun.sleep(40);
    const user = queue.execute(() => {}, 'send-keys', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral()).toBe(false);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['user-out'] })).toBe(true);
    await expect(user).resolves.toBe('user-out');
    queue.dispose();
  });

  test('literal orphan is parsed literally until its late block arrives', async () => {
    const { events, queue, parser } = createHarness();
    const capture = queue.execute(() => {}, 'capture-pane -p', {
      literal: true,
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: (block) => block.lines.join('\n'),
    });
    await expect(capture).rejects.toThrow(/timed out/);
    expect(queue.nextBlockIsLiteral('1 2 0')).toBe(true);
    parser.push(
      encoder.encode(
        '%begin 1 2 0\n%output this is terminal text\n%window-add also terminal text\n%end 1 2 0\n'
      )
    );
    expect(events).toEqual(['block-end']);
    const user = queue.execute(() => {}, 'send-keys', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral('1 3 0')).toBe(false);
    parser.push(encoder.encode('%begin 1 3 0\nuser-out\n%end 1 3 0\n%output %1 live\n'));
    await expect(user).resolves.toBe('user-out');
    expect(events).toEqual(['block-end', 'block-end', 'output']);
    queue.dispose();
  });

  test('two consecutive non-poison timeouts keep late blocks aligned in order', async () => {
    const queue = new ControlModeCommandQueue();
    const first = queue.execute(() => {}, 'display-message -p a', {
      timeoutMs: 80,
      poisonOnTimeout: false,
      transform: () => 'a',
    });
    await expect(first).rejects.toThrow(/timed out/);
    const second = queue.execute(() => {}, 'capture-pane -p', {
      literal: true,
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'b',
    });
    expect(queue.nextBlockIsLiteral()).toBe(false);
    await expect(second).rejects.toThrow(/timed out/);
    expect(queue.nextBlockIsLiteral()).toBe(false);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['late-a'] })).toBe(true);
    expect(queue.nextBlockIsLiteral()).toBe(true);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['late-b'] })).toBe(true);
    const user = queue.execute(() => {}, 'send-keys', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral()).toBe(false);
    expect(queue.handleBlock({ args: '', isError: false, lines: ['user-out'] })).toBe(true);
    await expect(user).resolves.toBe('user-out');
    queue.dispose();
  });

  test('orphan with a command-number only consumes its own block', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    expect(queue.nextBlockIsLiteral('1 10 0')).toBe(false);
    await expect(probe).rejects.toThrow(/timed out/);
    const user = queue.execute(() => {}, 'send-keys', {
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral('1 11 0')).toBe(false);
    expect(queue.handleBlock({ args: '1 11 0', isError: false, lines: ['user-out'] })).toBe(true);
    await expect(user).resolves.toBe('user-out');
    expect(queue.handleBlock({ args: '1 10 0', isError: false, lines: ['late-probe'] })).toBe(true);
    queue.dispose();
  });

  test('nextBlockIsLiteral skips a known-seq orphan that does not match the incoming begin', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    expect(queue.nextBlockIsLiteral('1 10 0')).toBe(false);
    await expect(probe).rejects.toThrow(/timed out/);
    const capture = queue.execute(() => {}, 'capture-pane -p', {
      literal: true,
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral('1 11 0')).toBe(true);
    expect(queue.handleBlock({ args: '1 11 0', isError: false, lines: ['%output pane'] })).toBe(
      true
    );
    await expect(capture).resolves.toBe('%output pane');
    expect(queue.handleBlock({ args: '1 10 0', isError: false, lines: ['vibeterm-lat'] })).toBe(
      true
    );
    queue.dispose();
  });

  test('expired orphan with a known seq is swallowed instead of delivered to the next command', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: (block) => block.lines.join('\n'),
    });
    expect(queue.nextBlockIsLiteral('1 10 0')).toBe(false);
    await expect(probe).rejects.toThrow(/timed out/);
    await Bun.sleep(40);
    const user = queue.execute(
      () => {},
      'display-message -p -t %1 "#{pane_width}|#{pane_height}"',
      {
        transform: (block) => {
          const info = block.lines[0]?.split('|');
          if (!info?.[0] || !info[1]) throw new Error('invalid tmux pane frame info');
          return block.lines[0];
        },
      }
    );
    expect(queue.nextBlockIsLiteral('1 11 0')).toBe(false);
    expect(queue.handleBlock({ args: '1 10 0', isError: false, lines: ['vibeterm-lat'] })).toBe(
      true
    );
    expect(queue.handleBlock({ args: '1 99 0', isError: false, lines: ['unrelated'] })).toBe(true);
    expect(queue.handleBlock({ args: '1 11 0', isError: false, lines: ['80|24'] })).toBe(true);
    await expect(user).resolves.toBe('80|24');
    queue.dispose();
  });

  test('expired-then-late begin does not stamp its seq onto the next pending command', async () => {
    const queue = new ControlModeCommandQueue();
    const probe = queue.execute(() => {}, 'display-message -p', {
      timeoutMs: 20,
      poisonOnTimeout: false,
      transform: () => 'probe',
    });
    expect(queue.nextBlockIsLiteral('1 10 0')).toBe(false);
    await expect(probe).rejects.toThrow(/timed out/);
    await Bun.sleep(40);
    const user = queue.execute(() => {}, 'display-message -p -t %1 frame', {
      transform: (block) => {
        if (block.lines[0] === 'vibeterm-lat') throw new Error('invalid tmux pane frame info');
        return block.lines[0];
      },
    });
    expect(queue.nextBlockIsLiteral('1 10 0')).toBe(false);
    expect(queue.handleBlock({ args: '1 10 0', isError: false, lines: ['vibeterm-lat'] })).toBe(
      true
    );
    expect(queue.nextBlockIsLiteral('1 11 0')).toBe(false);
    expect(queue.handleBlock({ args: '1 11 0', isError: false, lines: ['80|24'] })).toBe(true);
    await expect(user).resolves.toBe('80|24');
    queue.dispose();
  });
});
