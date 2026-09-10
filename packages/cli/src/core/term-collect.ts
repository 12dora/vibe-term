// `term capture` / `term run` 的采集侧：字节累积、静默判定、以及 `run` 的完成哨兵。
//
// 这里全是与 socket 无关的纯逻辑，命令只负责把 PaneData 喂进来。

import { stripAnsi, trimScreenText } from './vt-text';

/** 采集上限：`yes` 这类命令一秒就能刷爆内存，超过就停收并标记截断。 */
export const DEFAULT_COLLECT_MAX_BYTES = 8 * 1024 * 1024;

export class ByteCollector {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private cut = false;

  constructor(private readonly maxBytes: number = DEFAULT_COLLECT_MAX_BYTES) {}

  /** 收满之后返回 false：调用方据此提前收尾。 */
  append(bytes: Uint8Array): boolean {
    if (this.cut) return false;
    if (bytes.byteLength === 0) return true;
    const room = this.maxBytes - this.total;
    if (bytes.byteLength >= room) {
      this.cut = true;
      if (room > 0) {
        this.chunks.push(bytes.slice(0, room));
        this.total += room;
      }
      return false;
    }
    this.chunks.push(bytes.slice());
    this.total += bytes.byteLength;
    return true;
  }

  get truncated(): boolean {
    return this.cut;
  }

  get byteLength(): number {
    return this.total;
  }

  bytes(): Uint8Array {
    const merged = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  text(): string {
    return stripAnsi(this.bytes());
  }

  reset(): void {
    this.chunks.length = 0;
    this.total = 0;
    this.cut = false;
  }
}

export type IdleReason = 'idle' | 'timeout' | 'done';

export interface IdleWatcherOptions {
  /** 多久没有新字节算「静默」；0 表示不按静默结束。 */
  idleMs: number;
  /** 总时长上限。 */
  timeoutMs: number;
  now?: () => number;
}

/**
 * 「收到最后一个字节之后静默 N 毫秒」或「总时长超上限」二选一先到者结束。
 * `done()` 供哨兵命中时提前结束。
 */
export class IdleWatcher {
  private readonly startedAt: number;
  private lastActivityAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: ((reason: IdleReason) => void) | null = null;
  private finished: IdleReason | null = null;
  private readonly now: () => number;

  constructor(private readonly options: IdleWatcherOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.lastActivityAt = this.startedAt;
  }

  note(): void {
    this.lastActivityAt = this.now();
  }

  done(): void {
    this.finish('done');
  }

  /** `done()` 可能早于 `wait()`（首帧与发送在同一个 tick 里到达），所以结果要记着。 */
  wait(): Promise<IdleReason> {
    if (this.finished) return Promise.resolve(this.finished);
    return new Promise<IdleReason>((resolve) => {
      this.settle = resolve;
      this.arm();
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.settle = null;
  }

  private arm(): void {
    const elapsed = this.now() - this.startedAt;
    const remainingTotal = this.options.timeoutMs - elapsed;
    if (remainingTotal <= 0) {
      this.finish('timeout');
      return;
    }
    const idleLeft =
      this.options.idleMs > 0
        ? this.options.idleMs - (this.now() - this.lastActivityAt)
        : Number.POSITIVE_INFINITY;
    if (idleLeft <= 0) {
      this.finish('idle');
      return;
    }
    const delay = Math.max(1, Math.min(remainingTotal, idleLeft));
    this.timer = setTimeout(() => this.arm(), delay);
  }

  private finish(reason: IdleReason): void {
    const settle = this.settle;
    this.dispose();
    this.finished = reason;
    settle?.(reason);
  }
}

export interface RunSentinel {
  nonce: string;
  /** 唯一串本体；命令行回显与结果行都含它。 */
  token: string;
  /** 命令之后**单独一行**打进去的 shell 片段。 */
  line: string;
  /** 在洗白后的文本里找完成标记（只认数字形态）。 */
  find(text: string): { exitCode: number; line: string } | null;
  /** 这一行是不是哨兵相关（回显的 `$?` 形态也算）。 */
  mentions(text: string): boolean;
  /** 抹掉行内回显的哨兵命令，保留同一行上的真实输出。 */
  scrub(text: string): string;
}

/**
 * 完成哨兵：网关会吞掉 OSC 133（见 apps/gateway/.../pane-stream/osc-handlers.ts 的
 * `HANDLED_OSC_KINDS`），不可见标记根本到不了客户端，只能回显一个肉眼可见的唯一串。
 *
 * 它作为**独立的一行**打进去，不拼在命令后面：`cmd; echo …` 会被命令里的 `#` 注释掉、
 * 被未闭合的 heredoc 吞掉、被结尾的 `&` 挪进后台。单独一行的 `$?` 仍然是上一条命令的退出码。
 * 代价是它作为「预输入」躺在 tty 缓冲里，会被主动读 stdin 的命令吃掉——这类命令别用 `run`。
 */
export function createRunSentinel(nonce = randomNonce()): RunSentinel {
  const token = `__VT_DONE_${nonce}_`;
  const pattern = new RegExp(`${token}(\\d{1,3})\\b`);
  // 命令还在跑时哨兵行是「预输入」，由 tty 驱动即时回显，可能糊在输出行中间。
  const echoed = new RegExp(`\\(?echo\\s*${token}\\$\\?\\)?`, 'g');
  return {
    nonce,
    token,
    line: `(echo ${token}$?)`,
    find(text) {
      const match = pattern.exec(text);
      if (!match) return null;
      return { exitCode: Number(match[1]), line: match[0] };
    },
    mentions: (text) => text.includes(token),
    scrub: (text) => text.replace(echoed, ''),
  };
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface RunOutputOptions {
  /** 我们打进去的那条命令（不含哨兵行），用来判断第一行到底是不是回显。 */
  command?: string;
  sentinel?: RunSentinel | null;
}

function compact(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * 第一行到底是 shell 回显的命令，还是命令自己的第一行输出（`stty -echo` 时没有回显）？
 * 回显可能被窄 pane 的折行重画打散，所以按「压掉空白后是命令的子序列」判定——
 * 判不准时宁可留着，少剥一行不致命，多剥一行会丢输出。
 */
export function looksEchoed(head: string, command: string): boolean {
  const left = compact(head);
  const right = compact(command);
  if (!left) return true;
  if (left.length > right.length + 8) return false;
  return isSubsequence(left, right) || right.includes(left) || left.includes(right);
}

/** 结尾那一行没有换行收尾、又长得像提示符时，它是在等下一条命令，不是输出。 */
function dropTrailingPrompt(lines: string[]): string[] {
  const last = lines[lines.length - 1];
  if (last === undefined) return lines;
  if (!/[$%#>][\s\u00a0]*$/.test(last)) return lines;
  return lines.slice(0, -1);
}

/**
 * 尽力从「一条命令跑完后 pane 吐出的字节」里切出命令自己的输出：
 * 去掉 shell 回显的命令行、哨兵相关的行及其之后的内容、以及结尾等待输入的提示符。
 *
 * best-effort：提示符样式千奇百怪，pane 又是共享终端（别人可能同时在里面敲），
 * 剥不干净时宁可多留也不少留。要可靠的完成判定与退出码就用 `--marker`。
 */
/**
 * 切到「哨兵结果行」为止，并把之前那些回显的哨兵命令抹掉：命令还在跑时哨兵是预输入，
 * tty 会把它即时回显到输出中间，按整行丢会连带丢掉同一行的真实输出。
 */
function cutAtSentinel(lines: readonly string[], sentinel: RunSentinel): string[] {
  const hit = lines.findIndex((line) => sentinel.find(line) !== null);
  const source = hit >= 0 ? lines.slice(0, hit) : lines;
  const kept: string[] = [];
  for (const line of source) {
    if (!sentinel.mentions(line)) {
      kept.push(line);
      continue;
    }
    const scrubbed = sentinel.scrub(line);
    if (scrubbed.trim() !== '') kept.push(scrubbed);
  }
  return kept;
}

export function formatRunOutput(raw: Uint8Array, options: RunOutputOptions = {}): string {
  const newline = raw.indexOf(0x0a);
  const command = options.command;
  const echoed =
    newline >= 0 &&
    (command === undefined || looksEchoed(stripAnsi(raw.subarray(0, newline)), command));
  const body = echoed ? raw.subarray(newline + 1) : raw;
  let lines = stripAnsi(body).split('\n');
  const sentinel = options.sentinel;
  if (sentinel) {
    return trimScreenText(dropTrailingPrompt(cutAtSentinel(lines, sentinel)).join('\n'));
  }
  lines = dropTrailingPrompt(lines);
  return trimScreenText(lines.join('\n'));
}
