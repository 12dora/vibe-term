// 输出：人读的表格 / 机读的 JSON 二选一。
// 约定：结构化结果走 stdout，进度与提示走 stderr——`--json` 的调用方可以直接管道 stdout。

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
  color: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
}

const ANSI = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  reset: '\u001b[0m',
} as const;

export type AnsiStyle = keyof Omit<typeof ANSI, 'reset'>;

/** `--no-color` > `NO_COLOR` > `FORCE_COLOR` > stdout 是否 TTY。 */
export function shouldUseColor(
  noColorFlag: boolean,
  env: Record<string, string | undefined> = process.env,
  isTty = Boolean(process.stdout.isTTY)
): boolean {
  if (noColorFlag) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return true;
  return isTty;
}

export class Output {
  readonly json: boolean;
  readonly quiet: boolean;
  readonly color: boolean;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(options: OutputOptions) {
    this.json = options.json;
    this.quiet = options.quiet;
    this.color = options.color;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  style(text: string, style: AnsiStyle): string {
    return this.color ? `${ANSI[style]}${text}${ANSI.reset}` : text;
  }

  /** 结构化结果（stdout）。`--json` 时紧凑一行，否则缩进两格。 */
  data(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value, null, this.json ? 0 : 2)}\n`);
  }

  line(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  raw(bytes: Uint8Array): void {
    this.stdout.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** 人读提示；`--json` 或 `--quiet` 下静默。 */
  info(text: string): void {
    if (this.quiet || this.json) return;
    this.stderr.write(`${text}\n`);
  }

  warn(text: string): void {
    if (this.quiet) return;
    this.stderr.write(`${this.style(text, 'yellow')}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.style(text, 'red')}\n`);
  }

  /** 人读进度：TTY 上回车覆盖一行，否则逐行。`--json` / `--quiet` 静默。 */
  progress(text: string): void {
    if (this.json || this.quiet) return;
    const tty = Boolean((this.stderr as NodeJS.WriteStream).isTTY);
    this.stderr.write(tty ? `\r${text}\x1b[K` : `${text}\n`);
  }

  /** TTY 进度结束后换行，把后续 stderr 从覆盖行里拆出来。 */
  endProgress(): void {
    if (this.json || this.quiet) return;
    if ((this.stderr as NodeJS.WriteStream).isTTY) this.stderr.write('\n');
  }

  table<T>(rows: readonly T[], columns: readonly Column<T>[]): void {
    if (rows.length === 0) {
      this.info('(empty)');
      return;
    }
    const cells = rows.map((row) => columns.map((column) => column.value(row)));
    const widths = columns.map((column, index) =>
      Math.max(column.header.length, ...cells.map((row) => row[index].length))
    );
    this.line(
      this.style(
        columns
          .map((column, index) => column.header.padEnd(widths[index]))
          .join('  ')
          .trimEnd(),
        'bold'
      )
    );
    for (const row of cells) {
      this.line(
        row
          .map((cell, index) => cell.padEnd(widths[index]))
          .join('  ')
          .trimEnd()
      );
    }
  }
}

/**
 * 把第三方诊断日志（`@vibeterm/ws-client` 的连接状态等）从 stdout 挪到 stderr。
 *
 * stdout 是命令结果的专用通道，`--json` 的调用方直接管道它；库里的 `console.log`
 * 混进去就会把 JSON 搅坏。`--quiet` 时直接丢弃。
 */
export function captureDiagnostics(
  quiet: boolean,
  target: NodeJS.WritableStream = process.stderr
): void {
  const write = (...args: unknown[]) => {
    if (quiet) return;
    target.write(`${args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ')}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
}
