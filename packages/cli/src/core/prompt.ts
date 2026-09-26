// 交互输入：密码隐藏回显，TOTP 明文。非 TTY 一律不提示，由调用方给出非交互替代方案。

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { InterruptError } from './errors';

export function isInteractive(stdin: NodeJS.ReadStream = process.stdin): boolean {
  return Boolean(stdin.isTTY);
}

function clearPromptRawMode(input: NodeJS.ReadStream): void {
  if (typeof input.setRawMode !== 'function') return;
  try {
    input.setRawMode(false);
  } catch {
    // 非 TTY
  }
}

/**
 * 连续两次 `createInterface({ terminal: true })` 时，上一次 `close()` 会 pause stdin
 * 并可能把 TTY 留在 raw。Node 20+ 与 Bun 上若不先恢复，下一次 `question()` 收不到 line，
 * 密码问完就再也看不到两步验证提示。问完必须重新 pause，否则 stdin 会吊住进程退不出去。
 */
function armPromptInput(input: NodeJS.ReadStream): void {
  clearPromptRawMode(input);
  if (input.isPaused()) input.resume();
}

function releasePromptInput(input: NodeJS.ReadStream): void {
  clearPromptRawMode(input);
  if (!input.isPaused()) input.pause();
}

type PromptOutput = {
  output: Writable;
  mute: () => void;
  stop: () => void;
};

/**
 * readline 用 `output.columns` 折行，并在 `output` 的 `resize` 上重画（Node 与 Bun 都如此）。
 * 普通 Writable 没有宽度，列数会被当成 Infinity。
 */
function createPromptOutput(): PromptOutput {
  let hideEcho = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hideEcho) process.stderr.write(chunk);
      callback();
    },
  });
  Object.defineProperty(output, 'columns', {
    get: () => process.stderr.columns,
  });
  const onResize = (): void => {
    output.emit('resize');
  };
  process.stderr.on('resize', onResize);
  return {
    output,
    mute: () => {
      hideEcho = true;
    },
    stop: () => {
      process.stderr.removeListener('resize', onResize);
    },
  };
}

// 提示交给 readline。先 stderr.write 再 question('') 时，刷新的 `\x1b[1G\x1b[0J` 会把提示擦掉。
// question() 在 Node 与 Bun 上都同步写完提示；隐藏模式在它返回后立刻静音，后续刷新整段丢掉。
// Ctrl+C 拒绝；EOF / Ctrl+D（close 先于答案）以空串结束。这两种中断要补一个换行，
// 避免下一条消息粘在提示同一行；隐藏模式收尾本来就会补，不要写两次。
async function ask(prompt: string, hidden: boolean): Promise<string> {
  const input = process.stdin;
  armPromptInput(input);
  const proxy = createPromptOutput();
  const rl = createInterface({ input, output: proxy.output, terminal: true });
  let settled = false;
  let answered = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (value: string | Error): void => {
        if (settled) return;
        settled = true;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      rl.on('SIGINT', () => finish(new InterruptError()));
      rl.on('close', () => finish(''));
      rl.question(prompt, (answer) => {
        answered = true;
        finish(answer);
      });
      if (hidden) proxy.mute();
    });
  } finally {
    rl.close();
    proxy.stop();
    proxy.output.end();
    if (hidden || !answered) process.stderr.write('\n');
    releasePromptInput(input);
  }
}

export function promptHidden(prompt: string): Promise<string> {
  return ask(prompt, true);
}

export function promptLine(prompt: string): Promise<string> {
  return ask(prompt, false);
}

/** 读完整个 stdin（`--password-stdin` 用）；尾部换行一律去掉。 */
export async function readAllStdin(stream: NodeJS.ReadStream = process.stdin): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}
