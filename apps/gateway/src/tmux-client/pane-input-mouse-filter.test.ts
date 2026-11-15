import { describe, expect, test } from 'bun:test';
import type { InputSubmission } from './input-submission';
import { PaneInputPacer } from './pane-input-pacer';
import { TestClock } from './pane-input-test-helpers';
import type { PaneMouseFlags } from './pane-mouse-state';

const encode = (text: string) => new TextEncoder().encode(text);
const mouse = (button: number, col = 1, end = 'M') => `\x1b[<${button};${col};1${end}`;
const flags = (all: boolean, currentCommand = 'claude', button = false): PaneMouseFlags => ({
  standard: false,
  button,
  all,
  sgr: true,
  currentCommand,
});

function harness(options: { query?: boolean } = {}) {
  const clock = new TestClock();
  const writes: Array<{ text: string; submission: InputSubmission }> = [];
  const acks: Array<() => void> = [];
  const debugs: string[] = [];
  const queries: Array<{ paneId: string; answer: (value: PaneMouseFlags | null) => void }> = [];
  const pacer = new PaneInputPacer(
    (_pane, bytes, onAck, submission) => {
      submission.submitted = true;
      writes.push({ text: new TextDecoder().decode(bytes), submission });
      return new Promise<void>((resolve) => {
        acks.push(() => {
          onAck();
          resolve();
        });
      });
    },
    clock,
    () => {},
    undefined,
    { debug: (message) => debugs.push(message) }
  );
  if (options.query !== false) {
    pacer.setMouseQuery(
      (paneId) =>
        new Promise<PaneMouseFlags | null>((resolve) => queries.push({ paneId, answer: resolve }))
    );
  }
  const settle = async () => {
    for (let index = 0; index < 3; index += 1) await Promise.resolve();
  };
  const answer = async (value: PaneMouseFlags | null) => {
    queries.at(-1)?.answer(value);
    await settle();
  };
  const ackAll = () => {
    while (acks.length > 0) acks.shift()?.();
  };
  return {
    clock,
    writes,
    debugs,
    queries,
    pacer,
    answer,
    ackAll,
    texts: () => writes.map((write) => write.text),
    send: (text: string, pane = '%1') => pacer.sendInputBytes(pane, encode(text)),
    output: (text: string, pane = '%1') => pacer.onOutput(pane, encode(text)),
  };
}

describe('pane mouse filter', () => {
  test('unknown state holds hover, passes presses, then follows the flag answer', async () => {
    const h = harness();
    await h.send(mouse(35));
    h.send(mouse(0));
    expect(h.texts()).toEqual([mouse(0)]);
    expect(h.queries.map((query) => query.paneId)).toEqual(['%1']);
    await h.answer(flags(true));
    h.ackAll();
    h.send(mouse(35, 2));
    expect(h.texts()).toEqual([mouse(0), mouse(35, 2)]);
    expect(h.pacer.mouseReportsDropped).toBe(1);
  });

  test('only one query is in flight per pane and answers are throttled to one per 2 s', async () => {
    const h = harness();
    for (let col = 1; col <= 20; col += 1) h.send(mouse(35, col));
    h.send(mouse(35, 1, 'M'), '%2');
    expect(h.queries.map((query) => query.paneId)).toEqual(['%1', '%2']);
    h.queries[0].answer(flags(true));
    await h.answer(flags(true));
    h.clock.tick(1_999);
    h.ackAll();
    h.send(mouse(35, 3));
    expect(h.queries).toHaveLength(2);
    h.clock.tick(1);
    h.ackAll();
    h.send(mouse(35, 4));
    expect(h.queries).toHaveLength(3);
  });

  test('a failed query is retried no sooner than 2 s later', async () => {
    const h = harness();
    h.send(mouse(35));
    await h.answer(null);
    h.send(mouse(35, 2));
    expect(h.queries).toHaveLength(1);
    h.clock.tick(2_000);
    h.send(mouse(35, 3));
    expect(h.queries).toHaveLength(2);
    expect(h.writes).toHaveLength(0);
  });

  test('tracking off drops every mouse report but never keyboard input', async () => {
    const h = harness();
    h.send('a');
    h.send(mouse(0));
    await h.answer(flags(false, 'vim'));
    h.ackAll();
    for (const report of [mouse(0), mouse(0, 1, 'm'), mouse(32), mouse(35), mouse(64)]) {
      h.send(report);
    }
    h.send('b');
    h.ackAll();
    expect(h.texts()).toEqual(['a', mouse(0), 'b']);
    expect(h.pacer.mouseReportsDropped).toBe(5);
    expect(h.debugs).toHaveLength(1);
    expect(h.debugs[0]).toContain('mouse_reports_dropped=1');
    h.clock.tick(60_000);
    h.send(mouse(64));
    expect(h.debugs).toHaveLength(2);
  });

  test('an answer of tracking off discards mouse reports queued while unknown', async () => {
    const h = harness();
    h.send(mouse(0));
    h.send(mouse(0, 1, 'm'));
    h.send('key');
    await h.answer(flags(false));
    h.ackAll();
    expect(h.texts()).toEqual([mouse(0), 'key']);
  });

  test('a plain shell in the foreground overrides leftover tmux flags', async () => {
    const h = harness();
    h.send(mouse(35));
    await h.answer(flags(true, '-zsh'));
    h.send(mouse(35, 2));
    h.send(mouse(64));
    expect(h.writes).toHaveLength(0);
  });

  test('button tracking allows drag and wheel but not hover', async () => {
    const h = harness();
    h.send(mouse(0));
    await h.answer(flags(false, 'htop', true));
    h.ackAll();
    for (const report of [mouse(35, 2), mouse(32, 3), mouse(64, 4)]) {
      h.send(report);
      h.ackAll();
    }
    expect(h.texts()).toEqual([mouse(0), mouse(32, 3), mouse(64, 4)]);
  });

  test('live DECSET/DECRST drive the filter without a query function', () => {
    const h = harness({ query: false });
    h.send(mouse(35));
    h.ackAll();
    expect(h.texts()).toEqual([mouse(35)]);
    h.output('\x1b[?1002h');
    h.send(mouse(35, 2));
    h.send(mouse(32, 3));
    h.ackAll();
    h.output('\x1b[?1003;1006h');
    h.send(mouse(35, 4));
    h.ackAll();
    h.output('\x1b[?1000l');
    h.send(mouse(0, 5));
    h.send(`\x1b[M${String.fromCharCode(32, 33, 33)}`);
    expect(h.texts()).toEqual([mouse(35), mouse(32, 3), mouse(35, 4)]);
  });

  test('foreground command changes reset to off for shells and requery otherwise', async () => {
    const h = harness();
    h.send(mouse(0));
    await h.answer(flags(true));
    h.ackAll();
    h.pacer.noteCurrentCommand('%1', 'bash');
    h.send(mouse(0, 2));
    expect(h.texts()).toEqual([mouse(0)]);
    h.clock.tick(2_000);
    h.pacer.noteCurrentCommand('%1', 'node');
    expect(h.queries).toHaveLength(2);
    await h.answer(flags(true, 'node'));
    h.send(mouse(35, 3));
    expect(h.texts()).toEqual([mouse(0), mouse(35, 3)]);
  });

  test('refreshMouseState seeds a pane once per interval', async () => {
    const h = harness();
    h.pacer.refreshMouseState('%4');
    h.pacer.refreshMouseState('%4');
    expect(h.queries).toHaveLength(1);
    await h.answer(flags(true));
    h.send(mouse(35), '%4');
    expect(h.texts()).toEqual([mouse(35)]);
  });
});

describe('keyboard submissions', () => {
  test('contiguous keyboard input shares one submission while mouse entries keep their own', async () => {
    const h = harness({ query: false });
    h.send('a');
    h.send('b');
    h.send(mouse(64));
    h.send('c');
    expect(h.texts()).toEqual(['a', 'b', mouse(64)]);
    expect(h.writes[0].submission).toBe(h.writes[1].submission);
    expect(h.writes[2].submission).not.toBe(h.writes[1].submission);
    h.ackAll();
    expect(h.texts()).toEqual(['a', 'b', mouse(64), 'c']);
    expect(h.writes[3].submission).not.toBe(h.writes[2].submission);
  });
});
