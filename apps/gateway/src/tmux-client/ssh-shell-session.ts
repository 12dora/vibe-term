import type { Client, ClientChannel } from 'ssh2';

import { joinShellArgs, quoteShellArg } from './command-builder';
import type { CommandResult } from './external-tmux-core';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { resolveTmuxWindowStyle } from './window-style';

export interface PendingShellCommand {
  id: string;
  stderr: string;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SshShellSession {
  commandStream: ClientChannel | null;
  commandStdoutBuffer: string;
  pendingCommand: PendingShellCommand | null;
  commandQueue: Promise<void>;
}

export const COMMAND_SENTINEL = '\x1eTMEX_END ';

export function createSshShellSession(): SshShellSession {
  return {
    commandStream: null,
    commandStdoutBuffer: '',
    pendingCommand: null,
    commandQueue: Promise.resolve(),
  };
}

export function attachSshShellStream(
  session: SshShellSession,
  stream: ClientChannel,
  onUnexpectedClose: () => void
): void {
  session.commandStdoutBuffer = '';
  session.pendingCommand = null;
  session.commandStream = stream;
  stream.on('data', (data: Buffer) => {
    session.commandStdoutBuffer += data.toString();
    flushCommandBuffer(session);
  });
  stream.stderr.on('data', (data: Buffer) => {
    if (session.pendingCommand) {
      session.pendingCommand.stderr += data.toString();
    }
  });
  stream.on('close', () => {
    rejectPendingCommand(session, new Error('SSH command channel closed'));
    session.commandStream = null;
    onUnexpectedClose();
  });
}

export function closeSshShellSession(session: SshShellSession): void {
  rejectPendingCommand(session, new Error('SSH command channel closed'));
  session.commandStream?.end();
  session.commandStream?.close();
  session.commandStream?.destroy();
  session.commandStream = null;
}

export async function runShell(
  session: SshShellSession,
  command: string,
  timeoutMs = 10000
): Promise<CommandResult> {
  return enqueueShellCommand(session, command, timeoutMs);
}

export async function runShellAllowFailure(
  session: SshShellSession,
  command: string,
  timeoutMs = 10000
): Promise<CommandResult> {
  try {
    return await enqueueShellCommand(session, command, timeoutMs);
  } catch (error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

export function enqueueShellCommand(
  session: SshShellSession,
  command: string,
  timeoutMs: number
): Promise<CommandResult> {
  const next = session.commandQueue
    .catch(() => undefined)
    .then(() => executeShellCommand(session, command, timeoutMs));
  session.commandQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

export function executeShellCommand(
  session: SshShellSession,
  command: string,
  timeoutMs: number
): Promise<CommandResult> {
  const stream = session.commandStream;
  if (!stream) {
    return Promise.reject(new Error('SSH command channel not ready'));
  }

  const commandId = crypto.randomUUID();
  const wrappedCommand = `{ ${command}; } 2>&1\nprintf '\\036TMEX_END %s %d\\036\\n' ${quoteShellArg(
    commandId
  )} $?\n`;

  return new Promise<CommandResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!session.pendingCommand || session.pendingCommand.id !== commandId) {
        return;
      }
      session.pendingCommand = null;
      reject(new Error(`remote command timed out: ${command}`));
    }, timeoutMs);

    session.pendingCommand = {
      id: commandId,
      stderr: '',
      resolve,
      reject,
      timer,
    };
    stream.write(wrappedCommand);
  });
}

export function flushCommandBuffer(session: SshShellSession): void {
  while (true) {
    const sentinelIndex = session.commandStdoutBuffer.indexOf(COMMAND_SENTINEL);
    if (sentinelIndex < 0) {
      return;
    }

    const sentinelEnd = session.commandStdoutBuffer.indexOf(
      '\x1e',
      sentinelIndex + COMMAND_SENTINEL.length
    );
    if (sentinelEnd < 0) {
      return;
    }

    const payload = session.commandStdoutBuffer
      .slice(sentinelIndex + COMMAND_SENTINEL.length, sentinelEnd)
      .trim();
    const [commandId = '', exitCodeRaw = '1'] = payload.split(/\s+/);
    const stdout = session.commandStdoutBuffer.slice(0, sentinelIndex);
    session.commandStdoutBuffer = session.commandStdoutBuffer
      .slice(sentinelEnd + 1)
      .replace(/^\r?\n/, '');

    const pending = session.pendingCommand;
    if (!pending || pending.id !== commandId) {
      continue;
    }

    session.pendingCommand = null;
    clearTimeout(pending.timer);
    pending.resolve({
      exitCode: Number.parseInt(exitCodeRaw, 10) || 0,
      stdout,
      stderr: pending.stderr,
    });
  }
}

export function rejectPendingCommand(session: SshShellSession, error: Error): void {
  const pending = session.pendingCommand;
  if (!pending) {
    return;
  }

  session.pendingCommand = null;
  clearTimeout(pending.timer);
  pending.reject(error);
}

export async function runTmuxIsolated(
  sshClient: Client,
  tmuxBin: string,
  argv: string[],
  maxOutputBytes: number,
  timeoutMs: number
): Promise<CommandResult> {
  const command = `${quoteShellArg(tmuxBin)} ${joinShellArgs(argv)}`;
  const result = await executeIsolatedShellCommand(sshClient, command, maxOutputBytes, timeoutMs);
  if (result.exitCode === 0) return result;
  const message = (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `tmux command failed: ${argv.join(' ')}`
  ).trim();
  if (isTargetMissingMessage(message)) throw new TmuxTargetMissingError(message);
  throw new Error(message);
}

export function executeIsolatedShellCommand(
  sshClient: Client,
  command: string,
  maxOutputBytes: number,
  timeoutMs: number
): Promise<CommandResult> {
  const outputLimit = Math.max(1, Math.floor(maxOutputBytes));
  return new Promise<CommandResult>((resolve, reject) => {
    let settled = false;
    let exitCode = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stream: ClientChannel | null = null;

    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream?.close();
        stream?.destroy();
      } catch {}
      reject(error);
    };
    const timer = setTimeout(
      () => finishReject(new Error(`isolated SSH command timed out: ${command.slice(0, 80)}`)),
      timeoutMs
    );

    sshClient.exec(command, { pty: false }, (error, channel) => {
      if (error) {
        finishReject(error);
        return;
      }
      stream = channel;
      channel.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > outputLimit) {
          finishReject(new Error('tmux history capture exceeded bounded output'));
          return;
        }
        stdout.push(Buffer.from(chunk));
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.byteLength;
        if (stderrBytes > 8192) {
          finishReject(new Error('isolated SSH command stderr exceeded bounded output'));
          return;
        }
        stderr.push(Buffer.from(chunk));
      });
      channel.on('exit', (code: number | undefined) => {
        exitCode = code ?? 1;
      });
      channel.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout, stdoutBytes).toString(),
          stderr: Buffer.concat(stderr, stderrBytes).toString(),
        });
      });
    });
  });
}

export async function configureSshWindowStyle(options: {
  styleValue: string;
  deviceId: string;
  getSessionName: () => string;
  getTmuxBin: () => string;
  isDev: boolean;
  runTmuxAllowFailure: (argv: string[]) => Promise<CommandResult>;
  runShellAllowFailure: (command: string) => Promise<CommandResult>;
}): Promise<void> {
  const windowStyle = resolveTmuxWindowStyle(options.styleValue);
  if (!windowStyle) {
    return;
  }
  const startedAt = options.isDev ? Date.now() : 0;
  await options.runTmuxAllowFailure([
    'set-hook',
    '-t',
    options.getSessionName(),
    'after-new-window',
    `set-option -w window-style '${windowStyle}'`,
  ]);
  const windows = await options.runTmuxAllowFailure([
    'list-windows',
    '-t',
    options.getSessionName(),
    '-F',
    '#{window_id}',
  ]);
  if (windows.exitCode !== 0) {
    if (options.isDev) {
      console.debug(
        `[ssh] configureWindowStyle deviceId=${options.deviceId} elapsed=${Date.now() - startedAt}ms (list-windows failed)`
      );
    }
    return;
  }
  const windowIds: string[] = [];
  for (const line of windows.stdout.split('\n')) {
    const windowId = line.trim();
    if (!windowId) {
      continue;
    }
    windowIds.push(windowId);
  }
  if (windowIds.length > 0) {
    const setOptions = windowIds
      .map(
        (id) =>
          `${quoteShellArg(options.getTmuxBin())} set-option -w -t ${quoteShellArg(id)} window-style ${quoteShellArg(windowStyle)}`
      )
      .join(' && ');
    await options.runShellAllowFailure(setOptions);
  }
  if (options.isDev) {
    console.debug(
      `[ssh] configureWindowStyle deviceId=${options.deviceId} windows=${windowIds.length} elapsed=${Date.now() - startedAt}ms`
    );
  }
}
