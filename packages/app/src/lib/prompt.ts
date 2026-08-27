import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

export interface PromptContext {
  nonInteractive: boolean;
}

export async function promptText(
  ctx: PromptContext,
  message: string,
  defaultValue?: string
): Promise<string> {
  if (ctx.nonInteractive) {
    return defaultValue ?? '';
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue !== undefined ? ` (${defaultValue})` : '';
    const answer = (await rl.question(`${message}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    rl.close();
  }
}

export function isInteractiveStdin(): boolean {
  return Boolean(stdin.isTTY);
}

export async function promptPassword(
  message: string,
  options?: { envKey?: string; confirm?: boolean; confirmMessage?: string }
): Promise<string> {
  const envKey = options?.envKey ?? 'TMEX_PASSWORD';
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

async function readHiddenLine(prompt: string): Promise<string> {
  stdout.write(prompt);
  if (typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          stdout.write('\n');
          reject(new Error('Cancelled by user.'));
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
    const cleanup = (): void => {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };
    stdin.on('data', onData);
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

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${message} [${hint}]: `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }

    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;

    return defaultValue;
  } finally {
    rl.close();
  }
}
