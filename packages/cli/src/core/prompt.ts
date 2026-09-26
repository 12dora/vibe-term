// 交互输入：密码隐藏回显，TOTP 明文。非 TTY 一律不提示，由调用方给出非交互替代方案。

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

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

async function ask(prompt: string, hidden: boolean): Promise<string> {
  const input = process.stdin;
  armPromptInput(input);
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input, output, terminal: true });
  process.stderr.write(prompt);
  muted = hidden;
  try {
    return await new Promise<string>((resolve) => {
      rl.question('', resolve);
    });
  } finally {
    muted = false;
    rl.close();
    if (hidden) process.stderr.write('\n');
    clearPromptRawMode(input);
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
