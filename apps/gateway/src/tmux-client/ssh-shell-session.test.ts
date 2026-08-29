import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Client, ClientChannel } from 'ssh2';

import {
  COMMAND_SENTINEL,
  configureSshWindowStyle,
  createSshShellSession,
  executeIsolatedShellCommand,
  executeShellCommand,
  flushCommandBuffer,
  rejectPendingCommand,
  runShellAllowFailure,
  runTmuxIsolated,
} from './ssh-shell-session';
import { TmuxTargetMissingError } from './target-missing';

class FakeChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly writes: string[] = [];

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  end(): this {
    this.emit('close');
    return this;
  }

  close(): this {
    this.emit('close');
    return this;
  }

  destroy(): this {
    return this;
  }
}

class FakeIsolatedClient extends EventEmitter {
  failWith: Error | null = null;
  lastCommand = '';
  channel = new FakeChannel();

  exec(
    command: string,
    options: unknown,
    callback?: (error: Error | undefined, channel: ClientChannel) => void
  ): this {
    const cb =
      typeof options === 'function'
        ? (options as (error: Error | undefined, channel: ClientChannel) => void)
        : callback;
    this.lastCommand = command;
    if (this.failWith) {
      cb?.(this.failWith, undefined as unknown as ClientChannel);
      return this;
    }
    cb?.(undefined, this.channel as unknown as ClientChannel);
    return this;
  }
}

function asClient(client: FakeIsolatedClient): Client {
  return client as unknown as Client;
}

describe('flushCommandBuffer', () => {
  test('resolves the matching pending command and strips the sentinel', async () => {
    const session = createSshShellSession();
    const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        session.pendingCommand = {
          id: 'cmd-1',
          stderr: 'warn',
          resolve,
          reject,
          timer: setTimeout(() => {}, 60_000),
        };
      }
    );
    session.commandStdoutBuffer = `hello world${COMMAND_SENTINEL}cmd-1 0\x1e\nleftover`;
    flushCommandBuffer(session);
    await expect(result).resolves.toEqual({
      exitCode: 0,
      stdout: 'hello world',
      stderr: 'warn',
    });
    expect(session.commandStdoutBuffer).toBe('leftover');
    expect(session.pendingCommand).toBeNull();
  });

  test('waits when the sentinel is incomplete', () => {
    const session = createSshShellSession();
    session.commandStdoutBuffer = `partial${COMMAND_SENTINEL}cmd-1 0`;
    flushCommandBuffer(session);
    expect(session.commandStdoutBuffer).toBe(`partial${COMMAND_SENTINEL}cmd-1 0`);
  });

  test('skips a sentinel whose command id does not match pending', async () => {
    const session = createSshShellSession();
    const result = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        session.pendingCommand = {
          id: 'wanted',
          stderr: '',
          resolve,
          reject,
          timer: setTimeout(() => {}, 60_000),
        };
      }
    );
    session.commandStdoutBuffer = `noise${COMMAND_SENTINEL}other 1\x1e\nkept${COMMAND_SENTINEL}wanted 0\x1e\n`;
    flushCommandBuffer(session);
    await expect(result).resolves.toEqual({
      exitCode: 0,
      stdout: 'kept',
      stderr: '',
    });
  });
});

describe('rejectPendingCommand', () => {
  test('rejects and clears the pending command', async () => {
    const session = createSshShellSession();
    const result = new Promise((resolve, reject) => {
      session.pendingCommand = {
        id: 'cmd-1',
        stderr: '',
        resolve,
        reject,
        timer: setTimeout(() => {}, 60_000),
      };
    });
    rejectPendingCommand(session, new Error('SSH command channel closed'));
    await expect(result).rejects.toThrow('SSH command channel closed');
    expect(session.pendingCommand).toBeNull();
  });

  test('is a no-op without a pending command', () => {
    const session = createSshShellSession();
    rejectPendingCommand(session, new Error('unused'));
    expect(session.pendingCommand).toBeNull();
  });
});

describe('executeShellCommand', () => {
  test('rejects when the command stream is missing', async () => {
    const session = createSshShellSession();
    await expect(executeShellCommand(session, 'true', 1000)).rejects.toThrow(
      'SSH command channel not ready'
    );
  });

  test('writes the wrapped command and times out', async () => {
    const session = createSshShellSession();
    const stream = new FakeChannel();
    session.commandStream = stream as unknown as ClientChannel;
    await expect(executeShellCommand(session, 'sleep 9', 20)).rejects.toThrow(
      'remote command timed out: sleep 9'
    );
    expect(stream.writes[0]).toContain('{ sleep 9; } 2>&1');
    expect(stream.writes[0]).toContain('TMEX_END');
  });
});

describe('runShellAllowFailure', () => {
  test('maps a thrown error to exit code 1', async () => {
    const session = createSshShellSession();
    const result = await runShellAllowFailure(session, 'true', 1000);
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'SSH command channel not ready',
    });
  });
});

describe('executeIsolatedShellCommand', () => {
  test('resolves stdout, stderr, and exit code', async () => {
    const client = new FakeIsolatedClient();
    const pending = executeIsolatedShellCommand(asClient(client), 'echo hi', 1024, 1000);
    queueMicrotask(() => {
      client.channel.stderr.emit('data', Buffer.from('e'));
      client.channel.emit('data', Buffer.from('out'));
      client.channel.emit('exit', 3);
      client.channel.emit('close');
    });
    await expect(pending).resolves.toEqual({
      exitCode: 3,
      stdout: 'out',
      stderr: 'e',
    });
  });

  test('rejects when stdout exceeds the bound', async () => {
    const client = new FakeIsolatedClient();
    const pending = executeIsolatedShellCommand(asClient(client), 'capture', 4, 1000);
    queueMicrotask(() => {
      client.channel.emit('data', Buffer.from('12345'));
    });
    await expect(pending).rejects.toThrow('tmux history capture exceeded bounded output');
  });

  test('rejects when stderr exceeds 8192 bytes', async () => {
    const client = new FakeIsolatedClient();
    const pending = executeIsolatedShellCommand(asClient(client), 'capture', 4096, 1000);
    queueMicrotask(() => {
      client.channel.stderr.emit('data', Buffer.alloc(8193));
    });
    await expect(pending).rejects.toThrow('isolated SSH command stderr exceeded bounded output');
  });

  test('rejects when exec fails', async () => {
    const client = new FakeIsolatedClient();
    client.failWith = new Error('exec denied');
    await expect(executeIsolatedShellCommand(asClient(client), 'true', 1024, 1000)).rejects.toThrow(
      'exec denied'
    );
  });

  test('rejects on timeout', async () => {
    const client = new FakeIsolatedClient();
    await expect(
      executeIsolatedShellCommand(asClient(client), 'hang-command', 1024, 20)
    ).rejects.toThrow('isolated SSH command timed out: hang-command');
  });
});

describe('runTmuxIsolated', () => {
  test('throws TmuxTargetMissingError for a missing pane', async () => {
    const client = new FakeIsolatedClient();
    const pending = runTmuxIsolated(
      asClient(client),
      '/usr/bin/tmux',
      ['capture-pane'],
      1024,
      1000
    );
    queueMicrotask(() => {
      client.channel.stderr.emit('data', Buffer.from("can't find pane %9"));
      client.channel.emit('exit', 1);
      client.channel.emit('close');
    });
    await expect(pending).rejects.toBeInstanceOf(TmuxTargetMissingError);
  });
});

describe('configureSshWindowStyle', () => {
  test('returns immediately when the style is off', async () => {
    const calls: string[][] = [];
    await configureSshWindowStyle({
      styleValue: 'off',
      deviceId: 'd1',
      sessionName: 'tmex',
      tmuxBin: 'tmux',
      isDev: false,
      runTmuxAllowFailure: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runShellAllowFailure: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    expect(calls).toEqual([]);
  });

  test('stops after list-windows failure', async () => {
    const argvCalls: string[][] = [];
    let shellCalls = 0;
    await configureSshWindowStyle({
      styleValue: 'fg=#d0d0d0,bg=#262626',
      deviceId: 'd1',
      sessionName: 'tmex',
      tmuxBin: '/usr/bin/tmux',
      isDev: false,
      runTmuxAllowFailure: async (argv) => {
        argvCalls.push(argv);
        if (argv[0] === 'list-windows') {
          return { exitCode: 1, stdout: '', stderr: 'no session' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runShellAllowFailure: async () => {
        shellCalls += 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(argvCalls.map((argv) => argv[0])).toEqual(['set-hook', 'list-windows']);
    expect(shellCalls).toBe(0);
  });

  test('joins per-window set-option commands', async () => {
    let shellCommand = '';
    await configureSshWindowStyle({
      styleValue: 'fg=#d0d0d0,bg=#262626',
      deviceId: 'd1',
      sessionName: 'tmex',
      tmuxBin: '/usr/bin/tmux',
      isDev: false,
      runTmuxAllowFailure: async (argv) => {
        if (argv[0] === 'list-windows') {
          return { exitCode: 0, stdout: '@1\n\n@2\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      runShellAllowFailure: async (command) => {
        shellCommand = command;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(shellCommand).toContain("'@1'");
    expect(shellCommand).toContain("'@2'");
    expect(shellCommand).toContain(' && ');
  });
});
