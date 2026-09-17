import { openSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { ReadStream } from 'node:tty';

export interface PromptContext {
  nonInteractive: boolean;
}

type PromptInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  setEncoding: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
};

export interface PromptSession {
  input: PromptInput;
  release: () => void;
}

// Bun 读不到被 shell 重新打开的 /dev/tty：`curl install.sh | bash` 里 fd 0 正是这种
// 描述符（install.sh 用 `exec 3</dev/tty` + `<&3` 接回终端），此时 process.stdin 永远
// 收不到数据，提问就卡死。所以交互输入一律另开控制终端，用完即销毁——留着不销毁会吊住
// 事件循环，CLI 答完最后一问也退不出去。
export const promptInternals = {
  stdinIsTty: (): boolean => Boolean(stdin.isTTY),
  openControllingTerminal: (): PromptInput => new ReadStream(openSync('/dev/tty', 'r')),
};

export function createPromptSession(): PromptSession {
  if (!promptInternals.stdinIsTty()) {
    return { input: stdin, release: () => {} };
  }
  let opened: PromptInput;
  try {
    opened = promptInternals.openControllingTerminal();
  } catch {
    return { input: stdin, release: () => {} };
  }
  let released = false;
  return {
    input: opened,
    release: () => {
      if (released) return;
      released = true;
      (opened as unknown as { destroy?: () => void }).destroy?.();
    },
  };
}

async function askLine(message: string): Promise<string> {
  const session = createPromptSession();
  try {
    const rl = createInterface({ input: session.input, output: stdout });
    try {
      return (await rl.question(message)).trim();
    } finally {
      rl.close();
    }
  } finally {
    session.release();
  }
}

export async function promptText(
  ctx: PromptContext,
  message: string,
  defaultValue?: string
): Promise<string> {
  if (ctx.nonInteractive) {
    return defaultValue ?? '';
  }

  const suffix = defaultValue !== undefined ? ` (${defaultValue})` : '';
  const answer = await askLine(`${message}${suffix}: `);
  return answer || defaultValue || '';
}

export function isInteractiveStdin(): boolean {
  return promptInternals.stdinIsTty();
}

export async function promptPassword(
  message: string,
  options?: { envKey?: string; confirm?: boolean; confirmMessage?: string }
): Promise<string> {
  const envKey = options?.envKey ?? 'VIBETERM_PASSWORD';
  if (!isInteractiveStdin()) {
    const fromEnv = process.env[envKey] ?? '';
    if (!fromEnv) {
      throw new Error(
        `password is required: stdin is not a TTY, set ${envKey} for non-interactive use`
      );
    }
    if (options?.confirm) {
      const confirmKey = `${envKey}_CONFIRM`;
      const confirmValue = process.env[confirmKey];
      if (confirmValue !== undefined && confirmValue !== fromEnv) {
        throw new Error('password confirmation does not match');
      }
    }
    return fromEnv;
  }

  const first = await readHiddenLine(`${message}: `);
  if (!first) {
    throw new Error('password cannot be empty');
  }
  if (options?.confirm) {
    const second = await readHiddenLine(`${options.confirmMessage ?? 'Confirm password'}: `);
    if (first !== second) {
      throw new Error('password confirmation does not match');
    }
  }
  return first;
}

// 隐藏输入把终端打成 raw，任何一条退出路径漏掉恢复都会让用户留下一个不回显的 shell，
// 漏掉 release 则会吊住事件循环，所以恢复做成幂等，且 setup 抛错、流 error / end 都走它。
function restoreTerminal(session: PromptSession, restored: { done: boolean }): void {
  if (restored.done) return;
  restored.done = true;
  try {
    session.input.setRawMode?.(false);
    session.input.pause();
  } finally {
    session.release();
  }
}

async function readHiddenLine(prompt: string): Promise<string> {
  stdout.write(prompt);
  const session = createPromptSession();
  const input = session.input;
  const restored = { done: false };
  try {
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
  } catch (error) {
    restoreTerminal(session, restored);
    throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const settle = (finish: () => void): void => {
      input.off('data', onData);
      input.off('error', onError);
      input.off('end', onEnd);
      restoreTerminal(session, restored);
      finish();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r') {
          settle(() => {
            stdout.write('\n');
            resolve(value);
          });
          return;
        }
        if (char === '\u0003') {
          settle(() => {
            stdout.write('\n');
            reject(new Error('Cancelled by user.'));
          });
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char === '\u0015') {
          value = '';
          continue;
        }
        value += char;
      }
    };
    const onError = (error: Error): void => {
      settle(() => reject(error));
    };
    const onEnd = (): void => {
      settle(() => reject(new Error('input closed before a password was entered')));
    };
    input.on('data', onData);
    input.on('error', onError);
    input.on('end', onEnd);
  });
}

export async function promptConfirm(
  ctx: PromptContext,
  message: string,
  defaultValue: boolean
): Promise<boolean> {
  if (ctx.nonInteractive) {
    return defaultValue;
  }

  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await askLine(`${message} [${hint}]: `)).toLowerCase();
  if (!answer) {
    return defaultValue;
  }

  if (answer === 'y' || answer === 'yes') return true;
  if (answer === 'n' || answer === 'no') return false;

  return defaultValue;
}
