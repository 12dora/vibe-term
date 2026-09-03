import { afterEach, describe, expect, test } from 'bun:test';
import {
  type FakeDom,
  TEST_THEME,
  installFakeDom,
  restoreRealTerminalModules,
} from './test-support/fake-dom';
import type { GhosttyRenderRow } from './types';

const COLS = 32;
const ROWS = 6;

let dom: FakeDom | null = null;
let activeTerminal: { dispose(): void } | null = null;
let importVersion = 0;

afterEach(() => {
  activeTerminal?.dispose();
  activeTerminal = null;
  dom?.restore();
  dom = null;
});

async function flushAnimationFrames(fakeDom: FakeDom): Promise<void> {
  for (let index = 0; index < 4 && fakeDom.pendingAnimationFrames() > 0; index += 1) {
    await fakeDom.flushAnimationFrames();
  }
}

describe('synchronized output scroll rendering', () => {
  test('a write during DECSET 2026 disables shifted-row reuse before the fallback frame', async () => {
    restoreRealTerminalModules();
    importVersion += 1;
    const { createTerminalController } = await import(
      `./terminal.ts?synchronized-output-scroll=${importVersion}`
    );

    dom = installFakeDom();
    const terminal = await createTerminalController({
      theme: TEST_THEME,
      fontFamily: 'monospace',
      fontSize: 13,
      scrollback: 300,
    });
    activeTerminal = terminal;

    const container = dom.document.createElement('div');
    container.setBoundingClientRect({ width: 800, height: 480 });
    dom.document.body.appendChild(container);
    terminal.open(container as unknown as HTMLElement);
    terminal.resize(COLS, ROWS);
    terminal.write(
      Array.from(
        { length: 80 },
        (_, index) => `line-${index.toString().padStart(2, '0')}\r\n`
      ).join('')
    );
    await flushAnimationFrames(dom);

    terminal.write('\x1b[?2026h\x1b[1;1HCHANGED');
    expect(terminal.scrollLines(-1)).toBeTrue();
    await dom.flushAnimationFrames();

    const probe = terminal as unknown as {
      renderCoordinator: { lastRenderedRows: GhosttyRenderRow[] };
      renderState: { appliedScrollDelta: number };
    };
    expect(probe.renderState.appliedScrollDelta).toBe(0);
    expect(probe.renderCoordinator.lastRenderedRows[1]?.text.trimEnd()).toBe('CHANGED');

    terminal.refresh();
    expect(probe.renderCoordinator.lastRenderedRows[1]?.text.trimEnd()).toBe('CHANGED');
  });
});
