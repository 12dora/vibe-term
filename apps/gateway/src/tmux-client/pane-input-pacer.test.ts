import { describe, expect, test } from 'bun:test';
import { splitMouseSequences } from './mouse-sequence';
import { type InputLaneClock, PaneInputPacer } from './pane-input-pacer';

class TestClock implements InputLaneClock {
  time = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void {
    this.timers.delete(timer as number);
  }
  tick(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

const encode = (text: string) => new TextEncoder().encode(text);
const mouse = (button = 64, col = 1, end = 'M') => `\x1b[<${button};${col};1${end}`;

function setup() {
  const clock = new TestClock();
  const writes: Array<{ pane: string; text: string; at: number }> = [];
  const logs: string[] = [];
  const pacer = new PaneInputPacer(
    (pane, bytes) => {
      writes.push({ pane, text: new TextDecoder().decode(bytes), at: clock.now() });
    },
    clock,
    (line) => logs.push(line)
  );
  const send = (text: string, pane = '%1') => pacer.sendInputBytes(pane, encode(text));
  const output = (pane = '%1') => pacer.onOutput(pane, encode('redraw'));
  return { clock, writes, logs, pacer, send, output };
}

describe('SGR mouse classification', () => {
  test('splits complete sequences without changing bytes', () => {
    const text = mouse() + mouse(65, 123) + mouse(0, 5, 'm');
    expect(
      splitMouseSequences(encode(text))?.map((item) => new TextDecoder().decode(item.bytes))
    ).toEqual([mouse(), mouse(65, 123), mouse(0, 5, 'm')]);
  });
  test.each([
    '',
    'a',
    '\x1b[A',
    '\x1b[<64;1;M',
    '\x1b[<64;-1;1M',
    `${mouse()}\n`,
    `${mouse()}x`,
    `\ufeff${mouse()}`,
    `${mouse()}\x1b[<65;1;1`,
  ])('rejects non-mouse payload %j', (text) => {
    expect(splitMouseSequences(encode(text))).toBeNull();
  });
  test('invalid UTF-8 is regular input', () => {
    expect(splitMouseSequences(new Uint8Array([...encode(mouse()), 255]))).toBeNull();
  });
  test('only wheels with modifiers are droppable; motion and every release are protected', () => {
    for (const button of [64, 65, 66, 67, 68, 73, 82, 95]) {
      expect(splitMouseSequences(encode(mouse(button)))?.[0]?.droppable).toBe(true);
      expect(splitMouseSequences(encode(mouse(button, 1, 'm')))?.[0]?.droppable).toBe(false);
    }
    for (const button of [0, 1, 2, 3, 4, 8, 16, 32, 35, 96, 128, 4294967360]) {
      expect(splitMouseSequences(encode(mouse(button)))?.[0]?.droppable).toBe(false);
    }
  });
});

describe('per-pane input pacing', () => {
  test('one sequence is immediate and leaves no timer while idle', () => {
    const { send, writes, clock } = setup();
    send(mouse());
    expect(writes).toEqual([{ pane: '%1', text: mouse(), at: 0 }]);
    expect(clock.timers.size).toBe(0);
  });
  test('batched sequences are individually gated by each first output', () => {
    const { send, writes, clock, output } = setup();
    send(mouse(64, 1) + mouse(64, 2) + mouse(65, 3));
    expect(writes.length).toBe(1);
    clock.tick(20);
    output();
    expect(writes.map((item) => item.text)).toEqual([mouse(64, 1), mouse(64, 2)]);
    clock.tick(20);
    output();
    expect(writes.map((item) => item.at)).toEqual([0, 20, 40]);
    expect(clock.timers.size).toBe(0);
  });
  test('no output uses the initial 60 ms fallback repeatedly', () => {
    const { send, writes, clock } = setup();
    send(mouse().repeat(3));
    clock.tick(59);
    expect(writes.length).toBe(1);
    clock.tick(1);
    expect(writes.length).toBe(2);
    clock.tick(60);
    expect(writes.map((item) => item.at)).toEqual([0, 60, 120]);
  });
  test('EWMA adapts the next fallback from first output only', () => {
    const { send, writes, clock, output } = setup();
    send(mouse());
    clock.tick(35);
    output(); // 15 * .75 + 35 * .25 = 20; fallback = 80.
    clock.tick(5);
    output();
    send(mouse().repeat(2));
    clock.tick(79);
    expect(writes.length).toBe(2);
    clock.tick(1);
    expect(writes.map((item) => item.at)).toEqual([0, 40, 120]);
  });
  test('fallback is clamped to 40 ms for fast output', () => {
    const { send, writes, clock, output } = setup();
    for (let index = 0; index < 10; index += 1) {
      send(mouse());
      output();
      clock.tick(8);
    }
    send(mouse().repeat(2));
    clock.tick(39);
    expect(writes.length).toBe(11);
    clock.tick(1);
    expect(writes.length).toBe(12);
  });
  test('fallback is clamped to 250 ms for slow output', () => {
    const { send, writes, clock, output } = setup();
    send(mouse());
    clock.tick(1000);
    output();
    send(mouse().repeat(2));
    clock.tick(249);
    expect(writes.length).toBe(2);
    clock.tick(1);
    expect(writes.length).toBe(3);
  });
  test('streaming output cannot reduce spacing below 8 ms', () => {
    const { send, writes, clock, output } = setup();
    send(mouse().repeat(3));
    output();
    for (let index = 0; index < 7; index += 1) {
      clock.tick(1);
      output();
    }
    expect(writes.length).toBe(1);
    clock.tick(1);
    output();
    clock.tick(8);
    expect(writes.map((item) => item.at)).toEqual([0, 8, 16]);
  });
  test('minimum spacing also applies across separately arriving messages', () => {
    const { send, writes, clock, output } = setup();
    send(mouse());
    output();
    clock.tick(2);
    send(mouse());
    clock.tick(5);
    expect(writes.length).toBe(1);
    clock.tick(1);
    expect(writes.length).toBe(2);
  });
  test('empty output does not open the lane', () => {
    const { send, writes, clock, pacer } = setup();
    send(mouse().repeat(2));
    clock.tick(10);
    pacer.onOutput('%1', new Uint8Array());
    expect(writes.length).toBe(1);
    clock.tick(50);
    expect(writes.length).toBe(2);
  });
  test('drops newest wheels at the initial 20 pending budget without merging', () => {
    const { send, writes, logs, clock } = setup();
    send(Array.from({ length: 26 }, (_, index) => mouse(64, index + 1)).join(''));
    clock.tick(1500);
    expect(writes.map((item) => item.text)).toEqual(
      Array.from({ length: 21 }, (_, index) => mouse(64, index + 1))
    );
    expect(logs).toEqual(['[tmux][input-lane] pane=%1 dropped=1 pending=20 response_ms=15']);
  });
  test('adaptive budget bottoms out at three and protects press, release and motion', () => {
    const { send, writes, clock, output } = setup();
    send(mouse());
    clock.tick(1000);
    output();
    send(Array.from({ length: 10 }, (_, index) => mouse(65, index + 1)).join(''));
    const protectedEvents = [
      mouse(0),
      mouse(1),
      mouse(2),
      mouse(0, 1, 'm'),
      mouse(64, 1, 'm'),
      mouse(35),
    ];
    send(protectedEvents.join(''));
    send(mouse(66, 999));
    send('key');
    expect(writes.slice(1).map((item) => item.text)).toEqual([
      ...Array.from({ length: 4 }, (_, index) => mouse(65, index + 1)),
      ...protectedEvents,
      'key',
    ]);
  });
  test('adaptive budget never exceeds 64 pending', () => {
    const { send, writes, clock, output } = setup();
    for (let index = 0; index < 30; index += 1) {
      send(mouse());
      output();
      clock.tick(8);
    }
    const before = writes.length;
    send(mouse().repeat(100));
    send('key');
    expect(writes.length - before).toBe(66);
  });
  test('regular input drains pending sequences first and preserves arrival order', () => {
    const { send, writes, clock, output } = setup();
    const events = [mouse(64, 1), mouse(64, 2), mouse(65, 3)];
    send(events.join(''));
    send('paste\n');
    send(mouse(64, 4));
    expect(writes.map((item) => item.text)).toEqual([...events, 'paste\n']);
    clock.tick(8);
    output();
    expect(writes.at(-1)?.text).toBe(mouse(64, 4));
    clock.tick(1000);
    expect(writes.length).toBe(5);
  });
  test('mixed mouse and text is one regular input payload', () => {
    const { send, writes } = setup();
    send(mouse().repeat(2));
    const mixed = `${mouse()}abc${mouse(65)}`;
    send(mixed);
    expect(writes.map((item) => item.text)).toEqual([mouse(), mouse(), mixed]);
  });
  test('dispose cancels fallback and spacing timers and prevents future writes', () => {
    for (const openWithOutput of [false, true]) {
      const { send, writes, clock, output, pacer } = setup();
      send(mouse().repeat(3));
      if (openWithOutput) output();
      expect(clock.timers.size).toBe(1);
      pacer.dispose();
      pacer.dispose();
      send('key');
      output();
      clock.tick(1000);
      expect(clock.timers.size).toBe(0);
      expect(writes.length).toBe(1);
    }
  });
  test('dropping a pane cancels queued input and resets its timing on reuse', () => {
    const { send, writes, clock, pacer } = setup();
    send(mouse().repeat(3));
    pacer.dropPane('%1');
    expect(clock.timers.size).toBe(0);
    send(mouse());
    expect(writes.length).toBe(2);
    clock.tick(1000);
    expect(writes.length).toBe(2);
  });
  test('panes have independent output gates and lifecycle', () => {
    const { send, writes, clock, output, pacer } = setup();
    send(mouse().repeat(2));
    send(mouse(65).repeat(2), '%2');
    clock.tick(10);
    output('%2');
    expect(writes.map((item) => item.pane)).toEqual(['%1', '%2', '%2']);
    pacer.dropPane('%2');
    clock.tick(50);
    expect(writes.at(-1)?.pane).toBe('%1');
  });
  test('drop logs are rate limited independently per pane for five seconds', () => {
    const { send, logs, clock } = setup();
    send(mouse().repeat(100));
    send(mouse().repeat(100));
    send(mouse().repeat(100), '%2');
    expect(logs.length).toBe(2);
    clock.tick(4999);
    send(mouse().repeat(100));
    expect(logs.length).toBe(2);
    clock.tick(1);
    send(mouse().repeat(100));
    expect(logs.length).toBe(3);
    expect(logs[2]).toContain('pane=%1 dropped=259 pending=20');
  });
  test('queued bytes are owned by the lane', () => {
    const { pacer, writes, clock } = setup();
    const bytes = encode(mouse().repeat(2));
    pacer.sendInputBytes('%1', bytes);
    bytes.fill(0);
    clock.tick(60);
    expect(writes.map((item) => item.text)).toEqual([mouse(), mouse()]);
  });
  test('write failures are observed without leaking rejected promises', async () => {
    const clock = new TestClock();
    const errors: unknown[] = [];
    const error = new Error('closed');
    const pacer = new PaneInputPacer(
      () => Promise.reject(error),
      clock,
      () => {},
      (failure) => errors.push(failure)
    );
    pacer.sendInputBytes('%1', encode(mouse().repeat(2)));
    await Promise.resolve();
    clock.tick(60);
    await Promise.resolve();
    expect(errors).toEqual([error, error]);
    expect(clock.timers.size).toBe(0);
  });
});
