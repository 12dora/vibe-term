// forceFullRepaint() 若同时清掉行模型的「有输出」标记，位移感知行复用会把「同一次输出里
// 的原位重画」整批丢弃，且脏位已被消费 ⇒ 屏幕上那几行永久卡在上一帧的颜色
// （用户报的「Claude Code 输入框文字莫名变成浅绿」）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CanvasRendererFrame } from './canvas-renderer';
import { getGhosttyBindings } from './ghostty-wasm';
import { createRenderState, disposeRenderStateResources } from './render-state';
import type { LinkUnderlineSegment } from './terminal-links';
import { TerminalRenderCoordinator } from './terminal-render-coordinator';
import { TEST_THEME } from './test-support/fake-dom';
import type { GhosttyRenderRow } from './types';

const COLS = 32;
const ROWS = 6;

let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame;
let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame;

beforeEach(() => {
  previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (() => 1) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;
});

afterEach(() => {
  globalThis.requestAnimationFrame = previousRequestAnimationFrame;
  globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
});

async function createHarness() {
  const bindings = await getGhosttyBindings();
  const terminal = bindings.createTerminal(COLS, ROWS, 300);
  bindings.setTerminalTheme(terminal, TEST_THEME);
  const renderState = createRenderState(bindings);
  const frames: CanvasRendererFrame[] = [];

  for (let index = 0; index < 40; index += 1) {
    bindings.writeVt(terminal, `line-${index.toString().padStart(2, '0')}\r\n`);
  }

  const coordinator = new TerminalRenderCoordinator(bindings, terminal, renderState, {
    cellDimensions: () => ({ width: 8, height: 16 }),
    screenBounds: () => ({ left: 0, top: 0 }),
    viewportCols: () => COLS,
    viewportRows: () => ROWS,
    selectionRects: () => [],
    selectionText: () => null,
    selectionColor: () => 'rgba(80,80,80,0.4)',
    fileLinkContext: () => null,
    onSnapshot: () => {},
    onSelectionText: () => {},
  });
  coordinator.attach({
    kind: 'fake',
    render: (frame: CanvasRendererFrame) => frames.push(frame),
    drawSelectionOnly: () => {},
    drawLinkUnderlines: (_segments: LinkUnderlineSegment[]) => {},
    clearLinkUnderlines: () => {},
    commitCursor: () => {},
    dispose: () => {},
  } as unknown as Parameters<TerminalRenderCoordinator['attach']>[0]);

  // Ink 风格：把最后 4 行当成输入框，整块原位重画。
  const paintBox = (sgr: string) => {
    let out = '';
    for (let index = 0; index < 4; index += 1) {
      out += `\x1b[${ROWS - 3 + index};1H\x1b[2K${sgr}box-line-${index}\x1b[0m`;
    }
    return out;
  };

  return {
    bindings,
    terminal,
    renderState,
    coordinator,
    frames,
    paintBox,
    dispose: () => {
      coordinator.cancelPending();
      coordinator.cancelLinkOverlay();
      coordinator.dispose();
      disposeRenderStateResources(renderState);
      bindings.freeTerminal(terminal);
    },
  };
}

function fgAt(rows: GhosttyRenderRow[], y: number, x: number): string {
  const color = rows[y]?.cells[x]?.fgColor;
  return color ? `${color.r},${color.g},${color.b}` : 'default';
}

describe('EX2：输出与 forceFullRepaint 撞车时行内容被位移复用吞掉', () => {
  test('挂起期间的输出在恢复强制全画时仍禁用位移复用', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, harness.paintBox('\x1b[32m'));
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();
      harness.coordinator.renderNow();
      const framesBeforeSuspend = harness.frames.length;

      harness.coordinator.setRenderSuspended(true);
      harness.bindings.writeVt(harness.terminal, `\r\n${harness.paintBox('\x1b[0m')}`);
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();
      expect(harness.frames).toHaveLength(framesBeforeSuspend);

      harness.coordinator.setRenderSuspended(false);

      const resumed = harness.frames.at(-1);
      const colors = [0, 1, 2, 3].map((index) => fgAt(resumed?.rows ?? [], ROWS - 3 + index, 0));
      expect(harness.frames).toHaveLength(framesBeforeSuspend + 1);
      expect(resumed?.forceFull).toBe(true);
      expect(resumed?.scrollDelta).toBe(0);
      expect(colors).toEqual(['default', 'default', 'default', 'default']);
    } finally {
      harness.dispose();
    }
  });

  test('滚动 + 原位重画同批到达后 forceFullRepaint，输入框各行必须落到新颜色', async () => {
    const harness = await createHarness();
    try {
      // 基线：绿色输入框，连画两帧让它成为 settled 基线。
      harness.bindings.writeVt(harness.terminal, harness.paintBox('\x1b[32m'));
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();
      harness.coordinator.renderNow();
      expect(fgAt(harness.frames.at(-1)?.rows ?? [], ROWS - 3, 0)).toBe('0,170,0');

      // 一次输出：先追加一行（视口下移 1），再把输入框原位重画成默认色。
      harness.bindings.writeVt(harness.terminal, `\r\n${harness.paintBox('\x1b[0m')}`);
      harness.coordinator.noteOutput();

      // 这一帧不由 rAF 出，而是被 forceFullRepaint 抢先（切回标签页 / 窗口 focus /
      // DOM 重插入都会触发），它把 outputSinceRender 清成 false。
      harness.coordinator.forceFullRepaint();

      const immediate = [0, 1, 2, 3].map((index) =>
        fgAt(harness.frames.at(-1)?.rows ?? [], ROWS - 3 + index, 0)
      );
      // 脏位已被消费：再画几帧也不会自愈。
      harness.coordinator.renderNow();
      harness.coordinator.renderNow();
      const later = [0, 1, 2, 3].map((index) =>
        fgAt(harness.frames.at(-1)?.rows ?? [], ROWS - 3 + index, 0)
      );

      expect({ scrollDelta: harness.frames.at(-2)?.scrollDelta, immediate, later }).toEqual({
        scrollDelta: 0,
        immediate: ['default', 'default', 'default', 'default'],
        later: ['default', 'default', 'default', 'default'],
      });
    } finally {
      harness.dispose();
    }
  });

  test('对照：先 invalidateLines() 关掉位移复用（即拟议修复的效果）后同一序列正确', async () => {
    const harness = await createHarness();
    try {
      harness.bindings.writeVt(harness.terminal, harness.paintBox('\x1b[32m'));
      harness.coordinator.scheduleFromOutput();
      harness.coordinator.renderNow();
      harness.coordinator.renderNow();

      harness.bindings.writeVt(harness.terminal, `\r\n${harness.paintBox('\x1b[0m')}`);
      harness.coordinator.noteOutput();

      harness.coordinator.invalidateLines(); // ⇒ rowShiftInvalidated = true
      harness.coordinator.forceFullRepaint();

      const rows = harness.frames.at(-1)?.rows ?? [];
      expect(harness.frames.at(-1)?.scrollDelta).toBe(0);
      for (let index = 0; index < 4; index += 1) {
        expect(fgAt(rows, ROWS - 3 + index, 0)).toBe('default');
      }
    } finally {
      harness.dispose();
    }
  });
});
