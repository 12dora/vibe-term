// 极简 VT 洗白：把 pane 的原始字节流洗成纯文本，供 `term capture --strip-ansi` 与 `term run` 用。
//
// 比「正则删转义序列」多做一件事：按行覆盖。shell 的行编辑（zsh/fish 的补全提示）会用
// CR、退格与 EL 反复重画同一行，纯删除会把一行拆成好几段乱码，所以这里维护一张行画布，
// CR / BS / EL / ED 都真的作用在当前行上。
//
// 边界（写进用法说明，别指望它等价于终端仿真器）：
//   - 不实现绝对光标定位（CUP）、滚动区、备用屏。整屏重绘型 TUI（vim、top）洗出来仍然是
//     一堆片段，读它们请用 `term capture`（网关截屏本来就是逐行文本）。
//   - SGR、OSC、DCS 一律丢弃：颜色与标题不会出现在结果里。

const ESC = '\u001b';
const BEL = '\u0007';

/** 行画布：只有「当前行 + 列」这一点状态，够覆盖 shell 的行编辑。 */
class LineCanvas {
  private readonly rows: string[][] = [[]];
  private row = 0;
  private col = 0;

  private current(): string[] {
    let line = this.rows[this.row];
    if (!line) {
      line = [];
      this.rows[this.row] = line;
    }
    return line;
  }

  put(char: string): void {
    const line = this.current();
    while (line.length < this.col) line.push(' ');
    line[this.col] = char;
    this.col += 1;
  }

  /** LF 当 CRLF：网关截屏载荷用裸 LF 分行（`capture-pane` 的输出形态），列必须回 0。 */
  lineFeed(): void {
    this.row += 1;
    this.col = 0;
    this.rows[this.row] ??= [];
  }

  carriageReturn(): void {
    this.col = 0;
  }

  backspace(): void {
    this.col = Math.max(0, this.col - 1);
  }

  tab(): void {
    this.put('\t');
  }

  moveColumn(delta: number): void {
    this.col = Math.max(0, this.col + delta);
  }

  /** EL：0 删到行尾，1 删到行首，2 整行。 */
  eraseLine(mode: number): void {
    const line = this.current();
    if (mode === 2) {
      line.length = 0;
      return;
    }
    if (mode === 1) {
      for (let index = 0; index <= this.col && index < line.length; index += 1) line[index] = ' ';
      return;
    }
    line.length = Math.min(line.length, this.col);
  }

  /** ED 2 / 3：把已经收下的内容全部丢掉（截屏载荷开头就是 `ESC[2J`）。 */
  eraseDisplay(mode: number): void {
    if (mode !== 2 && mode !== 3) return;
    this.rows.length = 0;
    this.rows.push([]);
    this.row = 0;
    this.col = 0;
  }

  text(): string {
    return this.rows.map((line) => line.join('')).join('\n');
  }
}

interface CsiFrame {
  final: string;
  params: number[];
  next: number;
}

/** 读一段 CSI（`ESC [` 之后到终结符），返回参数与下一个下标。 */
function readCsi(text: string, start: number): CsiFrame {
  let index = start;
  let body = '';
  while (index < text.length) {
    const char = text[index];
    const code = char.charCodeAt(0);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) {
      return { final: char, params: parseParams(body), next: index };
    }
    body += char;
  }
  return { final: '', params: [], next: index };
}

function parseParams(body: string): number[] {
  const digits = body.replace(/^[?<>=!]/, '');
  if (!digits) return [];
  return digits.split(';').map((part) => (part === '' ? 0 : Number.parseInt(part, 10) || 0));
}

/** 读一段字符串型序列（OSC / DCS / SOS / PM / APC），到 BEL 或 ST 为止。 */
function skipStringSequence(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === BEL) return index + 1;
    if (char === ESC && text[index + 1] === '\\') return index + 2;
    index += 1;
  }
  return index;
}

function applyCsi(canvas: LineCanvas, frame: CsiFrame): void {
  const first = frame.params[0] ?? 0;
  if (frame.final === 'K') canvas.eraseLine(first);
  else if (frame.final === 'J') canvas.eraseDisplay(first);
  else if (frame.final === 'C') canvas.moveColumn(Math.max(1, first));
  else if (frame.final === 'D') canvas.moveColumn(-Math.max(1, first));
  else if (frame.final === 'G') canvas.carriageReturn();
}

/** ESC 之后：`[` 是 CSI，字符串型序列整段跳过，其余按「ESC + 一个字节」丢掉。 */
function applyEscape(canvas: LineCanvas, text: string, start: number): number {
  const kind = text[start];
  if (kind === undefined) return start + 1;
  if (kind === '[') {
    const frame = readCsi(text, start + 1);
    applyCsi(canvas, frame);
    return frame.next;
  }
  if (kind === ']' || kind === 'P' || kind === 'X' || kind === '^' || kind === '_') {
    return skipStringSequence(text, start + 1);
  }
  // ESC ( ) * + <charset>、ESC N/O <char> 都要多吞一个字节。
  if ('()*+NO'.includes(kind)) return start + 2;
  return start + 1;
}

/** 只认这四个 C0；其余控制字符（含 BEL、DEL）直接丢。 */
function applyControl(canvas: LineCanvas, char: string): void {
  if (char === '\n') canvas.lineFeed();
  else if (char === '\r') canvas.carriageReturn();
  else if (char === '\b') canvas.backspace();
  else if (char === '\t') canvas.tab();
}

export interface StripAnsiOptions {
  /** 去掉每行行尾空白并折掉结尾空行（`capture-pane -N` 会保留行尾空格）。默认开。 */
  trimLines?: boolean;
}

/** 原始 VT 字节 → 纯文本。 */
export function stripAnsi(bytes: Uint8Array, options: StripAnsiOptions = {}): string {
  return stripAnsiText(new TextDecoder('utf-8', { fatal: false }).decode(bytes), options);
}

export function stripAnsiText(input: string, options: StripAnsiOptions = {}): string {
  const canvas = new LineCanvas();
  let index = 0;
  while (index < input.length) {
    if (input[index] === ESC) {
      index = applyEscape(canvas, input, index + 1);
      continue;
    }
    // 按码点推进：星际平面字符（emoji）占两个 UTF-16 码元，逐码元处理会把它拆成两列乱码。
    const code = input.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    if (code <= 0x1f || code === 0x7f) {
      applyControl(canvas, String.fromCodePoint(code));
      continue;
    }
    canvas.put(String.fromCodePoint(code));
  }
  const text = canvas.text();
  return options.trimLines === false ? text : trimScreenText(text);
}

/** 行尾空白与结尾空行都去掉；行数与顺序不变。 */
export function trimScreenText(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
