import { describe, expect, test } from 'bun:test';
import type { PredictionCell, PredictionFrame } from 'ghostty-terminal';
import { nextAutoActive } from './activation';
import {
  PREDICTION_MIN_EXPIRY_MS,
  PREDICTION_SUSPECT_GRACE_MS,
  PREDICTION_SUSPEND_MS,
  createPredictionEngine,
  printableGraphemes,
} from './engine';

const WIDE_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠￠-￦]/u;
const textWidth = (text: string): 1 | 2 => (WIDE_RE.test(text) ? 2 : 1);

/** 模拟一块屏幕：绝对行 → 行内格子；write 按宽度写入并推进光标 */
class FakeScreen {
  cols = 20;
  rows = 5;
  viewportTop = 0;
  generation = 1;
  cursor = { row: 0, col: 0 };
  visible = true;
  passwordInput = false;
  altScreen = false;
  mouseReporting = false;
  synchronizedOutput = false;
  viewportAtBottom = true;
  private readonly lines = new Map<number, Map<number, PredictionCell>>();

  write(text: string): void {
    for (const grapheme of Array.from(text)) {
      const width = textWidth(grapheme);
      const line = this.line(this.viewportTop + this.cursor.row);
      line.set(this.cursor.col, { text: grapheme, wide: width === 2 });
      if (width === 2) line.set(this.cursor.col + 1, { text: '', wide: false });
      this.cursor.col += width;
    }
  }

  clearToEnd(): void {
    const line = this.line(this.viewportTop + this.cursor.row);
    for (const col of [...line.keys()]) if (col >= this.cursor.col) line.delete(col);
  }

  backspace(cells = 1): void {
    this.cursor.col -= cells;
    const line = this.line(this.viewportTop + this.cursor.row);
    for (let i = 0; i < cells; i += 1) line.delete(this.cursor.col + i);
  }

  newline(): void {
    this.cursor.col = 0;
    if (this.cursor.row === this.rows - 1) this.viewportTop += 1;
    else this.cursor.row += 1;
  }

  frame(): PredictionFrame {
    const top = this.viewportTop;
    return {
      cols: this.cols,
      rows: this.rows,
      cursor: {
        row: this.cursor.row,
        col: this.cursor.col,
        visible: this.visible,
        passwordInput: this.passwordInput,
      },
      altScreen: this.altScreen,
      mouseReporting: this.mouseReporting,
      synchronizedOutput: this.synchronizedOutput,
      viewportAtBottom: this.viewportAtBottom,
      viewportTop: top,
      generation: this.generation,
      cellAt: (row, col) => this.lines.get(top + row)?.get(col) ?? null,
    };
  }

  private line(row: number): Map<number, PredictionCell> {
    let line = this.lines.get(row);
    if (!line) {
      line = new Map();
      this.lines.set(row, line);
    }
    return line;
  }
}

function setup() {
  let clock = 1_000;
  const screen = new FakeScreen();
  const engine = createPredictionEngine({ textWidth, now: () => clock });
  return {
    screen,
    engine,
    advance(ms: number) {
      clock += ms;
    },
    type(data: string) {
      engine.onInput(data, screen.frame());
    },
    echo(text: string) {
      screen.write(text);
      engine.onFrame(screen.frame());
    },
    render() {
      engine.onFrame(screen.frame());
    },
    texts() {
      return engine.overlay()?.cells.map((cell) => cell.text) ?? [];
    },
    /** 可疑判定须在后续帧仍成立且已过宽限 */
    settle() {
      engine.onFrame(screen.frame());
      clock += PREDICTION_SUSPECT_GRACE_MS;
      engine.onFrame(screen.frame());
    },
  };
}

/** 先打一个字并等回显，让当前 epoch 进入已确认状态 */
function confirmEpoch(t: ReturnType<typeof setup>): void {
  t.type('a');
  t.echo('a');
}

describe('nextAutoActive', () => {
  test('滞回：≥50 开，<30 关，中间保持', () => {
    expect(nextAutoActive(false, 49)).toBe(false);
    expect(nextAutoActive(false, 50)).toBe(true);
    expect(nextAutoActive(true, 40)).toBe(true);
    expect(nextAutoActive(true, 29)).toBe(false);
    expect(nextAutoActive(true, null)).toBe(true);
    expect(nextAutoActive(false, null)).toBe(false);
  });
});

describe('printableGraphemes', () => {
  test('可打印文本按字素拆分，控制字符与超长粘贴返回 null', () => {
    expect(printableGraphemes('ab你')).toEqual(['a', 'b', '你']);
    expect(printableGraphemes('é')).toEqual(['é']);
    expect(printableGraphemes('a\r')).toBeNull();
    expect(printableGraphemes('\x1b[A')).toBeNull();
    expect(printableGraphemes('x'.repeat(40))).toBeNull();
  });
});

describe('createPredictionEngine', () => {
  test('新 epoch 先暂定不画，确认一次后后续预测立即画出', () => {
    const t = setup();
    t.type('a');
    expect(t.engine.overlay()).toBeNull();
    t.echo('a');
    expect(t.engine.overlay()).toBeNull();
    t.type('b');
    t.type('c');
    expect(t.engine.overlay()).toEqual({
      cells: [
        { row: 0, col: 1, text: 'b', wide: false, underline: true },
        { row: 0, col: 2, text: 'c', wide: false, underline: true },
      ],
      cursor: { row: 0, col: 3 },
    });
    t.echo('b');
    expect(t.texts()).toEqual(['c']);
    t.echo('c');
    expect(t.engine.overlay()).toBeNull();
  });

  test('暂定预测在首个确认后连同同 epoch 未决预测一起显示', () => {
    const t = setup();
    t.type('ab');
    expect(t.engine.overlay()).toBeNull();
    t.echo('a');
    expect(t.engine.overlay()?.cells).toEqual([
      { row: 0, col: 1, text: 'b', wide: false, underline: true },
    ]);
  });

  test('CJK 宽字符按两列步进并在两列宽处确认', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('你好');
    expect(t.engine.overlay()).toEqual({
      cells: [
        { row: 0, col: 1, text: '你', wide: true, underline: true },
        { row: 0, col: 3, text: '好', wide: true, underline: true },
      ],
      cursor: { row: 0, col: 5 },
    });
    t.echo('你');
    expect(t.texts()).toEqual(['好']);
    t.echo('好');
    expect(t.engine.overlay()).toBeNull();
  });

  test('退格擦除本 epoch 预测过的格子', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.type('\x7f');
    expect(t.engine.overlay()).toEqual({
      cells: [{ row: 0, col: 1, text: '', wide: false, underline: false }],
      cursor: { row: 0, col: 1 },
    });
    t.echo('b');
    expect(t.engine.overlay()?.cells.length).toBe(1);
    t.screen.backspace();
    t.render();
    expect(t.engine.overlay()).toBeNull();
    t.type('\x7f');
    expect(t.engine.overlay()?.cells).toEqual([
      { row: 0, col: 0, text: '', wide: false, underline: false },
    ]);
  });

  test('退格后同格重打：服务端尚未处理退格时的中间态不算误判', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.type('\x7f');
    t.type('c');
    t.echo('b');
    expect(t.texts()).toEqual(['c']);
    t.screen.backspace();
    t.echo('c');
    expect(t.engine.overlay()).toBeNull();
    t.type('d');
    expect(t.texts()).toEqual(['d']);
  });

  test('退格超出本 epoch 预测范围不预测并结束 epoch', () => {
    const t = setup();
    t.screen.write('$ ');
    confirmEpoch(t);
    t.type('\x7f');
    t.type('\x7f');
    expect(t.engine.overlay()?.cells.length).toBe(1);
    t.type('x');
    expect(t.engine.overlay()?.cells.length).toBe(1);
  });

  test('右边界不做换行预测', () => {
    const t = setup();
    t.screen.cols = 4;
    t.screen.write('ab');
    confirmEpoch(t);
    t.type('c');
    expect(t.engine.overlay()).toEqual({
      cells: [{ row: 0, col: 3, text: 'c', wide: false, underline: true }],
      cursor: { row: 0, col: 4 },
    });
    t.type('d');
    expect(t.engine.overlay()?.cursor).toBeNull();
    t.type('你');
    expect(t.texts()).toEqual(['c']);
  });

  test('宽字符放不下最后一列时不预测', () => {
    const t = setup();
    t.screen.cols = 3;
    t.screen.write('a');
    confirmEpoch(t);
    t.type('你');
    expect(t.engine.overlay()).toBeNull();
  });

  test('Enter 结束 epoch：清预测光标，旧预测继续对账，新预测重新暂定', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.type('\r');
    expect(t.engine.overlay()).toEqual({
      cells: [{ row: 0, col: 1, text: 'b', wide: false, underline: true }],
      cursor: null,
    });
    t.screen.write('b');
    t.screen.newline();
    t.render();
    expect(t.engine.overlay()).toBeNull();
    t.type('l');
    expect(t.engine.overlay()).toBeNull();
    t.echo('l');
    t.type('s');
    expect(t.engine.overlay()?.cells).toEqual([
      { row: 1, col: 1, text: 's', wide: false, underline: true },
    ]);
  });

  test('方向键等转义序列结束 epoch', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('\x1b[D');
    t.type('b');
    expect(t.engine.overlay()).toBeNull();
  });

  test('光标越过预测格但内容不同，在后续帧仍成立即误判，丢弃全部并回到暂定', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('bc');
    t.echo('x');
    expect(t.texts()).toEqual(['b', 'c']);
    t.advance(16);
    t.render();
    expect(t.texts()).toEqual(['b', 'c']);
    t.advance(PREDICTION_SUSPECT_GRACE_MS);
    t.render();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(1);
    t.type('d');
    expect(t.engine.overlay()).toBeNull();
  });

  test('光标跳到别的行而格子不符：后续帧仍成立即误判', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.screen.newline();
    t.render();
    expect(t.texts()).toEqual(['b']);
    t.settle();
    expect(t.engine.overlay()).toBeNull();
  });

  test('重绘途中单帧的光标跳动不算误判', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.screen.cursor = { row: 3, col: 0 };
    t.render();
    t.screen.cursor = { row: 0, col: 1 };
    t.render();
    expect(t.texts()).toEqual(['b']);
    t.screen.cursor = { row: 0, col: 0 };
    t.render();
    t.screen.cursor = { row: 0, col: 1 };
    t.render();
    t.echo('b');
    expect(t.engine.overlay()).toBeNull();
    t.type('c');
    expect(t.texts()).toEqual(['c']);
  });

  test('待定误判在后续帧出现且过了宽限后由 tick 落定', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.screen.newline();
    t.render();
    t.render();
    expect(t.engine.nextDeadline()).toBe(1_000 + PREDICTION_SUSPECT_GRACE_MS);
    t.advance(PREDICTION_SUSPECT_GRACE_MS - 1);
    t.engine.tick();
    expect(t.texts()).toEqual(['b']);

    const u = setup();
    confirmEpoch(u);
    u.type('b');
    u.screen.newline();
    u.render();
    u.render();
    expect(u.engine.nextDeadline()).toBe(1_000 + PREDICTION_SUSPECT_GRACE_MS);
    expect(u.texts()).toEqual(['b']);
    u.advance(PREDICTION_SUSPECT_GRACE_MS);
    u.engine.tick();
    expect(u.engine.overlay()).toBeNull();
    expect(u.engine.nextDeadline()).toBeNull();
    expect(u.engine.recentMismatches).toBe(1);
  });

  test('只有首个可疑帧、宽限后仍可疑：tick 静默清除，不计误判', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.screen.newline();
    t.render();
    expect(t.engine.nextDeadline()).toBe(1_000 + PREDICTION_SUSPECT_GRACE_MS);
    t.advance(PREDICTION_SUSPECT_GRACE_MS);
    t.engine.tick();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.nextDeadline()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
  });

  test('fish 缩写展开：单帧改写整行后静默，宽限后清掉错误预测', () => {
    const t = setup();
    t.screen.write('$ ');
    t.type('g');
    t.echo('g');
    t.type('co ma');
    expect(t.texts()).toEqual(['c', 'o', ' ', 'm', 'a']);
    t.screen.cursor.col = 2;
    t.echo('git checkout ma');
    expect(t.engine.overlay()).not.toBeNull();
    t.advance(PREDICTION_SUSPECT_GRACE_MS);
    t.engine.tick();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
    expect(t.engine.nextDeadline()).toBeNull();
  });

  test('非回显程序：暂定预测从不显示，超时后静默丢弃', () => {
    const t = setup();
    t.type('secret');
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.nextDeadline()).toBe(1_000 + PREDICTION_MIN_EXPIRY_MS);
    t.advance(PREDICTION_MIN_EXPIRY_MS + 1);
    t.engine.tick();
    expect(t.engine.nextDeadline()).toBeNull();
    expect(t.engine.suspended).toBe(false);
  });

  test('过期时限取 max(1500, 4×RTT)', () => {
    const t = setup();
    t.engine.setRttMs(500);
    confirmEpoch(t);
    t.type('b');
    t.advance(1_600);
    t.engine.tick();
    expect(t.texts()).toEqual(['b']);
    t.advance(500);
    t.engine.tick();
    expect(t.engine.overlay()).toBeNull();
  });

  test('滚动：绝对坐标随 viewportTop 平移', () => {
    const t = setup();
    t.screen.rows = 2;
    t.screen.newline();
    confirmEpoch(t);
    t.type('b');
    expect(t.engine.overlay()?.cells[0]).toMatchObject({ row: 1, col: 1 });
    t.screen.cursor = { row: 1, col: 1 };
    t.screen.viewportTop += 1;
    t.screen.cursor.row = 0;
    t.render();
    expect(t.engine.overlay()).toEqual({
      cells: [{ row: 0, col: 1, text: 'b', wide: false, underline: true }],
      cursor: { row: 0, col: 2 },
    });
    t.echo('b');
    expect(t.engine.overlay()).toBeNull();
  });

  test('generation 变化清空全部预测且不计误判', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    t.screen.generation += 1;
    t.render();
    expect(t.engine.overlay()).toBeNull();
    t.type('c');
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.suspended).toBe(false);
  });

  test('密码输入、备用屏、光标隐藏、鼠标上报、同步输出、回滚视口时不预测并清除', () => {
    const flags: Array<(screen: FakeScreen) => void> = [
      (s) => {
        s.passwordInput = true;
      },
      (s) => {
        s.altScreen = true;
      },
      (s) => {
        s.visible = false;
      },
      (s) => {
        s.mouseReporting = true;
      },
      (s) => {
        s.synchronizedOutput = true;
      },
      (s) => {
        s.viewportAtBottom = false;
      },
    ];
    for (const apply of flags) {
      const t = setup();
      confirmEpoch(t);
      t.type('b');
      expect(t.texts()).toEqual(['b']);
      apply(t.screen);
      t.render();
      expect(t.engine.overlay()).toBeNull();
      t.type('c');
      expect(t.engine.overlay()).toBeNull();
      expect(t.engine.nextDeadline()).toBeNull();
    }
  });

  test('暂定 epoch 里目标格已有内容时只占位不预测，也不结束 epoch', () => {
    const t = setup();
    t.screen.write('abc');
    t.screen.cursor.col = 1;
    t.type('x');
    t.render();
    expect(t.engine.nextDeadline()).toBeNull();
  });

  test('P0-1：回车后抢打的密码含空格，光标换到新行时不得画出，也不计误判', () => {
    const t = setup();
    t.screen.write('$ ');
    confirmEpoch(t);
    t.type('\r');
    t.type('ab cd');
    t.screen.newline();
    t.screen.write('[sudo] password: ');
    t.render();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
    t.settle();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
    expect(t.engine.suspended).toBe(false);
  });

  test('空格 / 擦除预测的确认不会把暂定 epoch 转为可见', () => {
    const t = setup();
    t.type(' ');
    t.type('b');
    t.echo(' ');
    expect(t.engine.overlay()).toBeNull();
    t.echo('b');
    t.type('c');
    expect(t.texts()).toEqual(['c']);
  });

  test('同一轮有可疑判定的 epoch 不因别的确认转为可见', () => {
    const t = setup();
    t.type('ab');
    t.screen.write('aZ');
    t.render();
    expect(t.engine.overlay()).toBeNull();
  });

  test('P1-1：连续输入全部落定后光标被别处挪走，新预测改锚真实光标并重新暂定', () => {
    const t = setup();
    t.screen.write('$ ');
    confirmEpoch(t);
    t.type('bc');
    t.echo('bc');
    expect(t.engine.overlay()).toBeNull();
    t.screen.cursor.col = 10;
    t.render();
    t.type('X');
    expect(t.engine.overlay()).toBeNull();
    t.echo('X');
    t.type('Y');
    expect(t.engine.overlay()?.cells).toEqual([
      { row: 0, col: 11, text: 'Y', wide: false, underline: true },
    ]);
  });

  test('P1-1：光标挪回已有内容处时不在旧锚点画字', () => {
    const t = setup();
    t.screen.write('$ ');
    confirmEpoch(t);
    t.type('bc');
    t.echo('bc');
    t.screen.cursor.col = 4;
    t.render();
    t.type('X');
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.nextDeadline()).toBeNull();
  });

  test('P1-2：可见 epoch 覆盖自动建议，与建议相同的字也要等光标越过才确认', () => {
    const t = setup();
    t.screen.write('$ ');
    t.type('l');
    t.echo('l');
    t.screen.write('sudo');
    t.screen.cursor.col = 3;
    t.render();
    t.type('s');
    t.type('x');
    expect(t.engine.overlay()).toEqual({
      cells: [
        { row: 0, col: 3, text: 's', wide: false, underline: true },
        { row: 0, col: 4, text: 'x', wide: false, underline: true },
      ],
      cursor: { row: 0, col: 5 },
    });
    t.render();
    expect(t.texts()).toEqual(['s', 'x']);
    t.echo('s');
    expect(t.texts()).toEqual(['x']);
    t.echo('x');
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
  });

  test('P1-2：暂定 epoch 遇到自动建议只占位，建议消失后预测继续', () => {
    const t = setup();
    t.screen.write('$ sudo');
    t.screen.cursor.col = 2;
    t.type('s');
    t.type('x');
    expect(t.engine.nextDeadline()).toBeNull();
    t.echo('sx');
    t.screen.clearToEnd();
    t.render();
    t.type('y');
    expect(t.engine.overlay()).toBeNull();
    t.echo('y');
    t.type('z');
    expect(t.engine.overlay()?.cells).toEqual([
      { row: 0, col: 5, text: 'z', wide: false, underline: true },
    ]);
  });

  test('P2-1：滚出视口的预测静默丢弃，不计误判', () => {
    const t = setup();
    t.screen.rows = 2;
    confirmEpoch(t);
    t.type('b');
    expect(t.texts()).toEqual(['b']);
    t.screen.viewportTop += 3;
    t.screen.cursor = { row: 1, col: 0 };
    t.render();
    expect(t.engine.overlay()).toBeNull();
    expect(t.engine.recentMismatches).toBe(0);
  });

  test('粘贴（breakRun）结束 epoch，后续输入重新暂定', () => {
    const t = setup();
    confirmEpoch(t);
    t.engine.breakRun();
    t.type('b');
    expect(t.engine.overlay()).toBeNull();
  });

  test('30 秒内 3 次可见误判后暂停 60 秒', () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      confirmEpoch(t);
      t.type('b');
      t.echo('x');
      t.settle();
      t.advance(1_000);
    }
    expect(t.engine.suspended).toBe(true);
    t.type('a');
    t.echo('a');
    t.type('b');
    expect(t.engine.overlay()).toBeNull();
    t.advance(PREDICTION_SUSPEND_MS);
    expect(t.engine.suspended).toBe(false);
    confirmEpoch(t);
    t.type('b');
    expect(t.texts()).toEqual(['b']);
  });

  test('超出 30 秒窗口的误判不累计', () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      confirmEpoch(t);
      t.type('b');
      t.echo('x');
      t.settle();
      t.advance(16_000);
    }
    expect(t.engine.suspended).toBe(false);
  });

  test('reset 清空并让下一帧不再按旧 generation 判定', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    const before = t.engine.version;
    t.engine.reset();
    expect(t.engine.version).toBeGreaterThan(before);
    expect(t.engine.overlay()).toBeNull();
    t.screen.generation += 5;
    t.render();
    confirmEpoch(t);
    t.type('c');
    expect(t.texts()).toEqual(['c']);
  });

  test('帧无变化时 version 不变', () => {
    const t = setup();
    confirmEpoch(t);
    t.type('b');
    const version = t.engine.version;
    t.render();
    t.render();
    expect(t.engine.version).toBe(version);
  });
});
