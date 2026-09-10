// `term capture` / `term run` 的采集侧：字节累积、静默判定、以及 `run` 的完成哨兵。
//
// 这里全是与 socket 无关的纯逻辑，命令只负责把 PaneData 喂进来。

import { stripAnsi, trimScreenText } from './vt-text';

export class ByteCollector {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push(bytes.slice());
    this.total += bytes.byteLength;
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
  /** 追加在命令后面的 shell 片段。 */
  suffix: string;
  /** 在洗白后的文本里找完成标记。 */
  find(text: string): { exitCode: number; line: string } | null;
}

/**
 * 完成哨兵：网关会吞掉 OSC 133（见 apps/gateway/.../pane-stream/osc-handlers.ts 的
 * `HANDLED_OSC_KINDS`），不可见标记根本到不了客户端，所以只能回显一个肉眼可见的唯一串。
 * 命令行回显里的那份写的是字面 `$?`，正则只认数字，因此不会误命中。
 */
export function createRunSentinel(nonce = randomNonce()): RunSentinel {
  const token = `__VT_DONE_${nonce}_`;
  const pattern = new RegExp(`${token}(\\d{1,3})\\b`);
  return {
    nonce,
    suffix: `; echo ${token}$?`,
    find(text) {
      const match = pattern.exec(text);
      if (!match) return null;
      return { exitCode: Number(match[1]), line: match[0] };
    },
  };
}

function randomNonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export interface RunOutputOptions {
  sentinel?: RunSentinel | null;
}

/** 命令行回显以 shell 回显的换行结束：第一个 LF 之前的一切都是「我们刚打进去的那一行」。 */
export function dropEchoedCommandLine(raw: Uint8Array): Uint8Array {
  const newline = raw.indexOf(0x0a);
  return newline < 0 ? raw : raw.subarray(newline + 1);
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
 * 去掉 shell 回显的命令行、哨兵行及其之后的内容、以及结尾等待输入的提示符。
 *
 * best-effort：提示符样式千奇百怪，pane 又是共享终端（别人可能同时在里面敲），
 * 剥不干净时宁可多留也不少留。要可靠的完成判定与退出码就用 `--marker`。
 */
export function formatRunOutput(raw: Uint8Array, options: RunOutputOptions = {}): string {
  const text = stripAnsi(dropEchoedCommandLine(raw));
  let lines = text.split('\n');
  const sentinel = options.sentinel;
  if (sentinel) {
    const hit = lines.findIndex((line) => sentinel.find(line) !== null);
    if (hit >= 0) return trimScreenText(lines.slice(0, hit).join('\n'));
  }
  lines = dropTrailingPrompt(lines);
  return trimScreenText(lines.join('\n'));
}
