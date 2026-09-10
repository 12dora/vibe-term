// 交互输入：密码隐藏回显，TOTP 明文。非 TTY 一律不提示，由调用方给出非交互替代方案。

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function isInteractive(stdin: NodeJS.ReadStream = process.stdin): boolean {
  return Boolean(stdin.isTTY);
}

async function ask(prompt: string, hidden: boolean): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write(prompt);
  muted = hidden;
  try {
    const answer = await new Promise<string>((resolve) => rl.question('', resolve));
    return answer;
  } finally {
    muted = false;
    rl.close();
    if (hidden) process.stderr.write('\n');
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
