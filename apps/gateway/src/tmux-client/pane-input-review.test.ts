import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeParser } from './control-mode-parser';
import { InputCommandWindow } from './input-command-window';
import { PaneInputPacer } from './pane-input-pacer';
import { TestClock } from './pane-input-test-helpers';

const encode = (text: string) => new TextEncoder().encode(text);
const mouse = (button = 64, col = 1, end = 'M') => `\x1b[<${button};${col};1${end}`;
const reply = (id: number) => `%begin 1 ${id} 1\n%end 1 ${id} 1\n`;

function harness() {
  const clock = new TestClock();
  const writes: Array<{ text: string; at: number; pane: string }> = [];
  const acknowledgments: Array<() => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const errors: unknown[] = [];
  const pacer = new PaneInputPacer(
    (pane, bytes, onAck) => {
      writes.push({ text: new TextDecoder().decode(bytes), at: clock.now(), pane });
      return new Promise<void>((resolve, reject) => {
        acknowledgments.push(() => {
          onAck();
          resolve();
        });
        failures.push(reject);
      });
    },
    clock,
    () => {},
    (error) => errors.push(error)
  );
  return {
    pacer,
    clock,
    writes,
    errors,
    fail: (index: number) => failures[index](new Error('transport failed')),
    ack: (index: number) => acknowledgments[index](),
    send: (text: string, pane = '%1') => pacer.sendInputBytes(pane, encode(text)),
    output: (text = 'redraw', pane = '%1') => pacer.onOutput(pane, encode(text)),
  };
}

describe('input lane review regressions', () => {
  test('ordinary input is a barrier behind every mouse acknowledgment and response', async () => {
    const h = harness();
    const wheels = h.send(mouse().repeat(3));
    const key = h.send('key');
    expect(h.writes).toHaveLength(1);
    h.clock.tick(100);
    h.output();
    expect(h.writes).toHaveLength(1);
    h.ack(0);
    h.output();
    h.clock.tick(7);
    expect(h.writes).toHaveLength(1);
    h.clock.tick(1);
    expect(h.writes).toHaveLength(2);
    h.clock.tick(100);
    expect(h.writes).toHaveLength(2);
    h.ack(1);
    h.output();
    h.clock.tick(8);
    expect(h.writes).toHaveLength(3);
    h.clock.tick(100);
    expect(h.writes).toHaveLength(3);
    h.ack(2);
    expect(h.writes.map((write) => write.text)).toEqual([mouse(), mouse(), mouse(), 'key']);
    h.ack(3);
    await Promise.all([wheels, key]);
    h.pacer.dispose();
  });

  test('an intervening ordinary barrier cannot erase the mouse output gate or spacing', () => {
    const h = harness();
    h.send(mouse());
    h.send('key');
    h.send(mouse(65));
    h.ack(0);
    expect(h.writes.map((write) => write.text)).toEqual([mouse(), 'key']);
    h.ack(1);
    h.clock.tick(7);
    expect(h.writes).toHaveLength(2);
    h.output();
    h.clock.tick(1);
    expect(h.writes).toHaveLength(2);
    h.clock.tick(2);
    expect(h.writes.map((write) => write.at)).toEqual([0, 0, 10]);
    h.pacer.dispose();
  });

  test.each([
    { segments: [9, 10, 11], readyAt: 17 },
    { segments: [9, 10, 11, 12, 13, 14, 15, 16], readyAt: 19 },
  ])('previous frame tail waits for quiet and minimum spacing: %j', ({ segments, readyAt }) => {
    const h = harness();
    h.send(mouse().repeat(3));
    h.ack(0);
    h.clock.tick(1);
    h.output();
    h.clock.tick(6);
    expect(h.writes).toHaveLength(1);
    h.clock.tick(1);
    expect(h.writes.map((write) => write.at)).toEqual([0, 8]);
    h.clock.tick(1);
    h.ack(1);
    for (const at of segments) {
      h.clock.tick(at - h.clock.now());
      h.output();
      expect(h.writes).toHaveLength(2);
    }
    while (h.clock.now() < readyAt - 1) {
      h.clock.tick(1);
      expect(h.writes).toHaveLength(2);
    }
    h.clock.tick(1);
    expect(h.writes.map((write) => write.at)).toEqual([0, 8, readyAt]);
    h.pacer.dispose();
  });

  test('continuous previous frame tail releases at the fallback captured by ack', () => {
    const h = harness();
    h.send(mouse().repeat(3));
    h.ack(0);
    h.clock.tick(1);
    h.output();
    h.clock.tick(7);
    h.clock.tick(1);
    h.ack(1);
    // 首次响应耗时 1 ms：EWMA = 15 × 0.75 + 1 × 0.25 = 11.5，回退为 46 ms。
    const fallbackMs = 46;
    for (let elapsed = 0; elapsed < fallbackMs; elapsed += 1) {
      h.output();
      expect(h.writes).toHaveLength(2);
      h.clock.tick(1);
    }
    expect(h.writes.map((write) => write.at)).toEqual([0, 8, 9 + fallbackMs]);
    h.pacer.dispose();
  });

  test('single segment frames retain eight ms spacing from each acknowledgment', () => {
    const h = harness();
    h.send(mouse().repeat(3));
    for (let index = 0; index < 2; index += 1) {
      h.ack(index);
      h.clock.tick(1);
      h.output();
      h.clock.tick(6);
      expect(h.writes).toHaveLength(index + 1);
      h.clock.tick(1);
      expect(h.writes).toHaveLength(index + 2);
    }
    expect(h.writes.map((write) => write.at)).toEqual([0, 8, 16]);
    h.pacer.dispose();
  });

  test('real parser counts redraw after %end in the same chunk, eight ms from ack', async () => {
    const clock = new TestClock();
    const writes: number[] = [];
    const window = new InputCommandWindow(() => 4);
    const queue = new ControlModeCommandQueue();
    const pacer = new PaneInputPacer(
      (_pane, _bytes, onAck) =>
        window.enqueue([['send-keys']], (argv) =>
          queue.execute(() => writes.push(clock.now()), argv.join(' '), {
            transform: () => undefined,
            onAck,
          })
        ),
      clock
    );
    const parser = createControlModeParser({
      onOutput: (pane, bytes) => pacer.onOutput(pane, bytes),
      onBlockEnd: (block) => queue.handleBlock(block),
      onNotification: () => {},
      onExit: () => {},
    });
    try {
      const done = pacer.sendInputBytes('%1', encode(mouse().repeat(2)));
      clock.tick(10);
      parser.push(encode(`${reply(1)}%output %1 redraw\n`));
      clock.tick(7);
      expect(writes).toEqual([0]);
      clock.tick(1);
      expect(writes).toEqual([0, 18]);
      parser.push(encode(reply(2)));
      await done;
    } finally {
      pacer.dispose();
      queue.dispose();
    }
  });

  test.each([1000, 1002, 1003])(
    'split reporting reset %i discards mice before releasing a key',
    (mode) => {
      const h = harness();
      h.output(`\x1b[?${mode}h`);
      h.send(mouse().repeat(4));
      h.send('key');
      h.clock.tick(10);
      h.ack(0);
      h.output(`\x1b[?${mode}`);
      h.output('l');
      expect(h.writes.map((write) => write.text)).toEqual([mouse(), 'key']);
      h.ack(1);
      h.clock.tick(1000);
      expect(h.writes).toHaveLength(2);
      h.pacer.dispose();
    }
  );

  test('reset before ack removes pending mice but keeps the ordinary barrier waiting', () => {
    const h = harness();
    h.send(mouse().repeat(3));
    h.send('key');
    h.output('\x1b[?1000;1002;1003l');
    h.clock.tick(1000);
    expect(h.writes).toHaveLength(1);
    h.ack(0);
    expect(h.writes.map((write) => write.text)).toEqual([mouse(), 'key']);
    h.pacer.dispose();
  });

  test('encoding reset and unrelated pane output do not disable reporting', () => {
    const h = harness();
    h.output('\x1b[?1000;1002h');
    h.send(mouse().repeat(3));
    h.ack(0);
    h.output('\x1b[?1000l');
    h.clock.tick(8);
    expect(h.writes).toHaveLength(2);
    h.ack(1);
    h.output('\x1b[?1002l', '%2');
    h.output('\x1b[?1006l');
    h.clock.tick(8);
    expect(h.writes).toHaveLength(3);
    h.pacer.dispose();
  });

  test.each(['ack', 'reject'] as const)(
    'transport generation rejects stale %s after 500 ms reattach',
    async (completion) => {
      const h = harness();
      h.send(mouse().repeat(21));
      h.pacer.invalidateTransport();
      expect(h.clock.timers.size).toBe(0);
      await expect(h.send('disconnected')).rejects.toThrow('unavailable');
      h.clock.tick(500);
      h.pacer.readyTransport();
      h.send(mouse(65).repeat(2));
      if (completion === 'ack') h.ack(0);
      else h.fail(0);
      await Promise.resolve();
      h.clock.tick(1000);
      expect(h.writes.map((write) => write.text)).toEqual([mouse(), mouse(65)]);
      h.ack(1);
      h.output();
      h.clock.tick(8);
      expect(h.writes.map((write) => write.text)).toEqual([mouse(), mouse(65), mouse(65)]);
      h.pacer.dispose();
    }
  );

  test('failed write cancels all pending entries without fallback or another write', async () => {
    const h = harness();
    const pending = h.send(mouse().repeat(21));
    const key = h.send('key');
    h.fail(0);
    await expect(pending).rejects.toThrow();
    await expect(key).rejects.toThrow();
    h.clock.tick(1000);
    expect(h.errors).toHaveLength(1);
    expect(h.writes).toHaveLength(1);
    expect(h.clock.timers.size).toBe(0);
    h.pacer.dispose();
  });

  test('synchronous failure rejects the rest of the same batch', async () => {
    const pacer = new PaneInputPacer(
      () => {
        throw new Error('closed');
      },
      new TestClock(),
      () => {},
      () => {}
    );
    await expect(pacer.sendInputBytes('%1', encode(mouse().repeat(21)))).rejects.toThrow('closed');
    pacer.dispose();
  });

  test.each([35, 160])(
    '120 Hz motion button=%i coalesces and leaves room for wheels and clicks',
    (button) => {
      const h = harness();
      h.send(mouse(button));
      for (let col = 2; col <= 121; col += 1) {
        h.clock.tick(1000 / 120);
        h.send(mouse(button, col));
      }
      h.send(mouse(64, 2) + mouse(64, 3) + mouse(0) + mouse(0, 1, 'm'));
      for (let index = 0; index < 6; index += 1) {
        h.ack(index);
        h.output();
        h.clock.tick(8);
      }
      expect(h.writes.map((write) => write.text)).toEqual([
        mouse(button),
        mouse(button, 121),
        mouse(64, 2),
        mouse(64, 3),
        mouse(0),
        mouse(0, 1, 'm'),
      ]);
      h.pacer.dispose();
    }
  );

  test('incompatible motion backlog is bounded without merging buttons, release or wheels', () => {
    const h = harness();
    h.send(mouse(35));
    const motions = Array.from({ length: 120 }, (_, index) =>
      mouse(index % 2 ? 32 : 35, index + 2)
    );
    h.send(motions.join(''));
    const boundary = [mouse(0), mouse(0, 1, 'm'), mouse(64, 8), mouse(64, 9)];
    h.send(boundary.join(''));
    for (let index = 0; index < 25; index += 1) {
      h.ack(index);
      h.output();
      h.clock.tick(8);
    }
    expect(h.writes.map((write) => write.text)).toEqual([
      mouse(35),
      ...motions.slice(0, 20),
      ...boundary,
    ]);
    h.pacer.dispose();
  });

  test('press and release separate compatible motion groups', () => {
    const h = harness();
    const events = [
      mouse(35),
      mouse(35, 2),
      mouse(0),
      mouse(35, 3),
      mouse(0, 1, 'm'),
      mouse(35, 4),
    ];
    h.send(events.join(''));
    for (let index = 0; index < events.length; index += 1) {
      h.ack(index);
      h.output();
      h.clock.tick(8);
    }
    expect(h.writes.map((write) => write.text)).toEqual(events);
    h.pacer.dispose();
  });
});
