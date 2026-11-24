import { describe, expect, test } from 'bun:test';
import type {
  PredictionCell,
  PredictionFrame,
  PredictionOverlay,
  TerminalPredictionHost,
} from 'ghostty-terminal';
import { PredictiveEchoController } from './controller';
import { PREDICTION_MIN_EXPIRY_MS } from './engine';
import {
  notePaneInput,
  pasteWithoutPrediction,
  pickLinkRttMs,
  readLinkRttMs,
  registerPanePrediction,
  watchLinkRtt,
} from './use-predictive-echo';

class FakeHost implements TerminalPredictionHost {
  overlays: Array<PredictionOverlay | null> = [];
  listeners = new Set<(frame: PredictionFrame) => void>();
  cells = new Map<number, PredictionCell>();
  cursorCol = 0;
  generation = 1;
  rendered = true;

  setOverlay(overlay: PredictionOverlay | null): void {
    this.overlays.push(overlay);
  }

  onFrame(callback: (frame: PredictionFrame) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  frame(): PredictionFrame | null {
    if (!this.rendered) return null;
    return {
      cols: 80,
      rows: 24,
      cursor: { row: 0, col: this.cursorCol, visible: true, passwordInput: false },
      altScreen: false,
      mouseReporting: false,
      synchronizedOutput: false,
      viewportAtBottom: true,
      viewportTop: 0,
      generation: this.generation,
      cellAt: (row, col) => (row === 0 ? (this.cells.get(col) ?? null) : null),
    };
  }

  textWidth(): 1 | 2 {
    return 1;
  }

  echo(text: string): void {
    for (const char of text) {
      this.cells.set(this.cursorCol, { text: char, wide: false });
      this.cursorCol += 1;
    }
    this.render();
  }

  render(): void {
    const frame = this.frame();
    if (!frame) return;
    for (const listener of this.listeners) listener(frame);
  }

  get lastOverlay(): PredictionOverlay | null | undefined {
    return this.overlays.at(-1);
  }
}

class FakeTextarea extends EventTarget {}

function setup() {
  let clock = 10_000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerSeq = 0;
  const host = new FakeHost();
  const textarea = new FakeTextarea();
  const controller = new PredictiveEchoController({
    host,
    textarea: textarea as unknown as HTMLElement,
    now: () => clock,
    setTimer: (run, delay) => {
      timerSeq += 1;
      timers.set(timerSeq, { at: clock + delay, run });
      return timerSeq as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });
  return {
    host,
    textarea,
    controller,
    timers,
    advance(ms: number) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

function confirmEpoch(t: ReturnType<typeof setup>): void {
  t.controller.noteInput('a');
  t.host.echo('a');
}

describe('PredictiveEchoController', () => {
  test('未激活时不订阅帧、不下发 overlay', () => {
    const t = setup();
    t.controller.noteInput('a');
    t.host.echo('a');
    expect(t.host.listeners.size).toBe(0);
    expect(t.host.overlays).toEqual([]);
  });

  test('激活后确认一次再输入即下发带下划线的预测与预测光标', () => {
    const t = setup();
    t.controller.setActive(true);
    expect(t.host.listeners.size).toBe(1);
    confirmEpoch(t);
    expect(t.host.overlays).toEqual([]);
    t.controller.noteInput('b');
    expect(t.host.lastOverlay).toEqual({
      cells: [{ row: 0, col: 1, text: 'b', wide: false, underline: true }],
      cursor: { row: 0, col: 2 },
    });
    t.host.echo('b');
    expect(t.host.lastOverlay).toBeNull();
    expect(t.host.overlays.length).toBe(2);
  });

  test('无帧的过期由定时器兜底清除', () => {
    const t = setup();
    t.controller.setActive(true);
    confirmEpoch(t);
    t.controller.noteInput('b');
    expect(t.timers.size).toBe(1);
    t.advance(PREDICTION_MIN_EXPIRY_MS + 5);
    expect(t.host.lastOverlay).toBeNull();
    expect(t.timers.size).toBe(0);
  });

  test('输入法组字开始清除 overlay，组字期间忽略帧，提交文本照常预测', () => {
    const t = setup();
    t.controller.setActive(true);
    confirmEpoch(t);
    t.controller.noteInput('b');
    t.textarea.dispatchEvent(new Event('compositionstart'));
    expect(t.host.lastOverlay).toBeNull();
    t.host.echo('b');
    t.controller.noteInput('c');
    t.textarea.dispatchEvent(new Event('compositionend'));
    t.host.echo('c');
    t.controller.noteInput('d');
    expect(t.host.lastOverlay?.cells.map((cell) => cell.text)).toEqual(['d']);
  });

  test('reset 与关闭都会清掉已显示的 overlay 并退订', () => {
    const t = setup();
    t.controller.setActive(true);
    confirmEpoch(t);
    t.controller.noteInput('b');
    t.controller.reset();
    expect(t.host.lastOverlay).toBeNull();
    t.controller.noteInput('c');
    expect(t.host.lastOverlay).toBeNull();
    t.host.echo('c');
    t.controller.noteInput('d');
    expect(t.host.lastOverlay?.cells.length).toBe(1);
    t.controller.setActive(false);
    expect(t.host.lastOverlay).toBeNull();
    expect(t.host.listeners.size).toBe(0);
    expect(t.timers.size).toBe(0);
    const count = t.host.overlays.length;
    t.controller.noteInput('e');
    expect(t.host.overlays.length).toBe(count);
  });

  test('首帧前（frame 为 null）不预测', () => {
    const t = setup();
    t.host.rendered = false;
    t.controller.setActive(true);
    t.controller.noteInput('a');
    expect(t.timers.size).toBe(0);
  });

  test('RTT 影响过期时限', () => {
    const t = setup();
    t.controller.setActive(true);
    t.controller.setRttMs(1_000);
    confirmEpoch(t);
    t.controller.noteInput('b');
    t.advance(PREDICTION_MIN_EXPIRY_MS + 5);
    expect(t.host.lastOverlay?.cells.length).toBe(1);
    t.advance(4_000);
    expect(t.host.lastOverlay).toBeNull();
  });
});

describe('粘贴不预测', () => {
  test('noteInput 标记为粘贴时只结束 epoch', () => {
    const t = setup();
    t.controller.setActive(true);
    confirmEpoch(t);
    t.controller.noteInput('b', true);
    expect(t.host.overlays).toEqual([]);
    expect(t.timers.size).toBe(0);
  });

  test('textarea paste 事件期间同步发出的字节按粘贴处理，微任务后恢复', async () => {
    const t = setup();
    t.controller.setActive(true);
    confirmEpoch(t);
    t.textarea.dispatchEvent(new Event('paste'));
    t.controller.noteInput('b');
    expect(t.host.overlays).toEqual([]);
    await Promise.resolve();
    t.host.echo('b');
    t.controller.noteInput('c');
    expect(t.host.overlays).toEqual([]);
    t.host.echo('c');
    t.controller.noteInput('d');
    expect(t.host.lastOverlay?.cells.map((cell) => cell.text)).toEqual(['d']);
  });

  test('pasteWithoutPrediction 只在 paste 调用期间标记实例', () => {
    const seen: string[] = [];
    const instance = { paste: (text: string) => seen.push(text) };
    pasteWithoutPrediction(instance as never, 'hello');
    expect(seen).toEqual(['hello']);
  });
});

describe('旁路输入登记', () => {
  test('notePaneInput 只转给同 runtime 同 pane 已登记的控制器', () => {
    const runtime = {};
    const notes: string[] = [];
    const ref = { current: { noteInput: (data: string) => notes.push(data) } };
    const off = registerPanePrediction(runtime, 'd1', 'p1', ref as never);
    notePaneInput(runtime, 'd1', 'p1', '\x1b[D');
    notePaneInput(runtime, 'd1', 'p2', 'x');
    notePaneInput({}, 'd1', 'p1', 'y');
    off();
    notePaneInput(runtime, 'd1', 'p1', 'z');
    expect(notes).toEqual(['\x1b[D']);
  });
});

describe('link RTT', () => {
  test('watchLinkRtt 立即回调一次，心跳与直连诊断变化时再回调，退订后静默', () => {
    const transportHandlers = new Set<(event: { type: string }) => void>();
    const directHandlers = new Set<() => void>();
    let latency: number | null = 20;
    const runtime = {
      transport: {
        get latencyMs() {
          return latency;
        },
        onEvent: (handler: (event: { type: string }) => void) => {
          transportHandlers.add(handler);
          return () => transportHandlers.delete(handler);
        },
      },
      directDiagnostics: () => ({
        get: () => ({ path: 'primary' as const, route: null, rtt: null, ice: null }),
        subscribe: (listener: () => void) => {
          directHandlers.add(listener);
          return () => directHandlers.delete(listener);
        },
      }),
    };
    const samples: Array<number | null> = [];
    const off = watchLinkRtt(runtime as never, (rtt) => samples.push(rtt));
    latency = 120;
    for (const handler of transportHandlers) handler({ type: 'latency' });
    for (const handler of transportHandlers) handler({ type: 'pane-output' });
    for (const handler of directHandlers) handler();
    off();
    expect(transportHandlers.size).toBe(0);
    expect(directHandlers.size).toBe(0);
    expect(samples).toEqual([20, 120, 120]);
  });

  test('直连取 ICE RTT，否则取心跳', () => {
    expect(pickLinkRttMs({ path: 'direct', rtt: 110 }, 140)).toBe(110);
    expect(pickLinkRttMs({ path: 'direct', rtt: null }, 140)).toBe(140);
    expect(pickLinkRttMs({ path: 'primary', rtt: 90 }, 12)).toBe(12);
    expect(pickLinkRttMs(null, null)).toBeNull();
  });

  test('readLinkRttMs 读 runtime 的直连诊断与 transport 心跳', () => {
    const transport = { latencyMs: 80 } as never;
    expect(readLinkRttMs({ transport })).toBe(80);
    expect(
      readLinkRttMs({
        transport,
        directDiagnostics: () => ({
          get: () => ({ path: 'direct', route: null, rtt: 120, ice: null }),
          subscribe: () => () => undefined,
        }),
      })
    ).toBe(120);
  });
});
