// 录制快照必须在「录制时的网格」下写入：这条用真的 ghostty wasm 跑，不用假控制器。
//
// 后端拼快照时是按当时 pane 的行列拼的（primary 屏：CSI 2J CSI H + history + 可见行 + 绝对 CUP），
// 直接写进更高的仿真终端，history 会留在可见区、CUP 会落进 history 里；
// 先调回录制网格再写、写完调回来，ghostty 就会像真终端被拉高那样把 history 拉回 scrollback，
// 提示行仍在内容末尾，光标仍在提示行上。

import { describe, expect, test } from 'bun:test';
import { HeadlessTerminal } from 'ghostty-terminal/headless';
import {
  type FitAddonLike,
  type ReadOnlyController,
  ReadOnlyTerminalSession,
} from './hooks/read-only-terminal-session';

const RECORDED = { cols: 80, rows: 24 };
const WINDOW = { cols: 100, rows: 40 };
const HISTORY = ['H01 scrollback', 'H02 scrollback', 'H03 scrollback'];
const PROMPT = '$ ';

/** primary 屏快照：history + 24 行可见内容 + 绝对 CUP（光标停在最后一行的提示符后）。 */
function primaryCheckpoint(): string {
  const visible = [
    ...Array.from({ length: 23 }, (_, index) => `V${String(index + 1).padStart(2, '0')} visible`),
    PROMPT,
  ];
  return `\x1b[2J\x1b[H${HISTORY.join('\r\n')}\r\n${visible.join('\r\n')}\x1b[${
    RECORDED.rows
  };${PROMPT.length + 1}H`;
}

/** alt 屏快照：不带 history，24 行画面贴左上，光标在左下。 */
function alternateCheckpoint(): string {
  const rows = Array.from(
    { length: RECORDED.rows },
    (_, index) => `A${String(index + 1).padStart(2, '0')} tui`
  );
  return `\x1b[?1049h\x1b[2J\x1b[H${rows.join('\r\n')}\x1b[${RECORDED.rows};1H`;
}

function headlessFit(grid: { cols: number; rows: number }): FitAddonLike {
  return {
    dispose: () => {},
    activate: () => {},
    proposeDimensions: () => grid,
  };
}

function headlessController(term: HeadlessTerminal): ReadOnlyController {
  return {
    element: { querySelector: () => null },
    write: (data: Uint8Array | string) => term.write(data),
    resize: (cols: number, rows: number) => term.resize(cols, rows),
    reset: () => term.write('\x1b[2J\x1b[H'),
    dispose: () => term.free(),
    open: () => {},
    loadAddon: () => {},
  } as unknown as ReadOnlyController;
}

function createMount(): HTMLElement {
  return {
    clientWidth: 800,
    clientHeight: 600,
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
    querySelector: () => null,
    closest: () => null,
  } as unknown as HTMLElement;
}

async function bootHeadlessSession(): Promise<{
  session: ReadOnlyTerminalSession;
  term: HeadlessTerminal;
}> {
  const term = await HeadlessTerminal.create({ cols: WINDOW.cols, rows: WINDOW.rows });
  const session = new ReadOnlyTerminalSession(
    false,
    headlessController(term),
    headlessFit(WINDOW),
    createMount(),
    { minGrid: RECORDED }
  );
  session.tryFitToContainer();
  return { session, term };
}

function viewportLines(term: HeadlessTerminal): string[] {
  return term.render().split('\n');
}

describe('writeCheckpoint 在录制网格下写快照（真 ghostty）', () => {
  test('primary 屏：history 退回 scrollback，提示行仍是最后一行，光标还在提示行上', async () => {
    const { session, term } = await bootHeadlessSession();
    session.handle.writeCheckpoint(primaryCheckpoint(), RECORDED);
    // 快照之后录像继续输出：字符必须落在提示行的光标处，这是「CUP 有没有落对」的判据。
    session.handle.write('ZZZ');
    const lines = viewportLines(term);
    const promptLine = lines.findIndex((line) => line.startsWith(`${PROMPT}ZZZ`));
    expect(promptLine, `lines=${JSON.stringify(lines)}`).toBeGreaterThanOrEqual(0);
    // 提示行是最后一行有内容的行；history 与可见行都在它上面。
    expect(lines.slice(promptLine + 1).every((line) => line.trim() === '')).toBe(true);
    expect(lines.some((line) => line.startsWith('H01'))).toBe(true);
    expect(lines.some((line) => line.startsWith('V23'))).toBe(true);
    expect(term.size()).toEqual(WINDOW);
    session.dispose();
  });

  test('对照：直接按窗口网格写同一份快照，续写就落不到提示行上', async () => {
    const { session, term } = await bootHeadlessSession();
    session.handle.write(primaryCheckpoint());
    session.handle.write('ZZZ');
    const lines = viewportLines(term);
    expect(lines.some((line) => line.startsWith(`${PROMPT}ZZZ`))).toBe(false);
    session.dispose();
  });

  test('alt 屏：画面贴左上，24 行之后是空的', async () => {
    const { session, term } = await bootHeadlessSession();
    session.handle.writeCheckpoint(alternateCheckpoint(), RECORDED);
    const lines = viewportLines(term);
    expect(lines[0]).toContain('A01 tui');
    expect(lines[RECORDED.rows - 1]).toContain(`A${RECORDED.rows} tui`);
    expect(lines.slice(RECORDED.rows).every((line) => line.trim() === '')).toBe(true);
    expect(term.size()).toEqual(WINDOW);
    session.dispose();
  });
});
