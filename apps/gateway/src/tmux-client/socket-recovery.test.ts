import { describe, expect, test } from 'bun:test';

import { ControlModeCommandQueue } from './control-mode-capture';
import { isTmuxServerGoneMessage, isTmuxSocketMissingMessage } from './external/helpers';
import type { CommandResult } from './external/types';
import {
  type SocketRecoveryHost,
  type SocketRecoveryShell,
  TmuxSocketRecovery,
  buildSocketRecoveryScript,
  parseTmuxServerPid,
  parseTmuxSocketPathFromMessage,
  retryAfterSocketRecovery,
} from './socket-recovery';

const SOCKET_MISSING = 'error connecting to /tmp/tmux-1000/default (No such file or directory)';

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(stderr: string): CommandResult {
  return { exitCode: 1, stdout: '', stderr };
}

interface RecoveryHarness {
  recovery: TmuxSocketRecovery;
  host: SocketRecoveryHost & { connected: boolean; manualDisconnect: boolean };
  scripts: string[];
  probes: string[][];
  controlWrites: string[];
}

function createRecovery(options: {
  pidReply?: string | null;
  socketPathReply?: string;
  shellExitCode?: number;
  probeResults?: CommandResult[];
  now?: () => number;
}): RecoveryHarness {
  const queue = new ControlModeCommandQueue();
  const scripts: string[] = [];
  const probes: string[][] = [];
  const controlWrites: string[] = [];
  const probeResults = options.probeResults ? [...options.probeResults] : null;

  const host = {
    deviceId: 'dev-1',
    logPrefix: '[test]',
    connected: true,
    manualDisconnect: false,
    controlCommands: queue,
    getControlWriter: () =>
      options.pidReply === null
        ? null
        : (command: string) => {
            controlWrites.push(command.trim());
            const line = command.includes('#{pid}')
              ? (options.pidReply ?? '2064')
              : (options.socketPathReply ?? '/tmp/tmux-1000/default');
            // 控制通道照常回执：socket 不可达只影响新起的一次性命令。
            queue.handleBlock({ args: '', isError: false, lines: [line] });
          },
    getControlCommandTimeoutMs: () => 1_000,
    runTmuxAllowFailure: async (argv: string[]) => {
      probes.push(argv);
      if (!probeResults) return ok('2064');
      return probeResults.shift() ?? fail(SOCKET_MISSING);
    },
  };

  const shell: SocketRecoveryShell = {
    runHostShell: async (script) => {
      scripts.push(script);
      return { stdout: '', stderr: '', exitCode: options.shellExitCode ?? 0 };
    },
  };

  // 默认时钟每次读取推进 5 ms，让轮询超时分支在几轮内收敛，不依赖真实时间。
  let clock = 1_000_000;
  const recovery = new TmuxSocketRecovery(host, shell, {
    pollIntervalMs: 1,
    pollTimeoutMs: 20,
    now:
      options.now ??
      (() => {
        clock += 5;
        return clock;
      }),
    sleep: async () => {},
  });
  return { recovery, host, scripts, probes, controlWrites };
}

describe('tmux socket-missing 分类', () => {
  test('socket 不可达与 server 消失是两类，绝不互相匹配', () => {
    expect(isTmuxSocketMissingMessage(SOCKET_MISSING)).toBe(true);
    expect(isTmuxServerGoneMessage(SOCKET_MISSING)).toBe(false);

    const serverGone = 'no server running on /tmp/tmux-1000/default';
    expect(isTmuxServerGoneMessage(serverGone)).toBe(true);
    expect(isTmuxSocketMissingMessage(serverGone)).toBe(false);
  });

  test('只有 connecting + no such file 同时出现才算 socket 不可达', () => {
    expect(isTmuxSocketMissingMessage('error connecting to /tmp/x (Connection refused)')).toBe(
      false
    );
    expect(isTmuxSocketMissingMessage('open /etc/x: no such file or directory')).toBe(false);
    expect(isTmuxSocketMissingMessage("can't find pane %9")).toBe(false);
  });
});

describe('socket 路径与 pid 解析', () => {
  test('从失败消息里取出绝对路径', () => {
    expect(parseTmuxSocketPathFromMessage(SOCKET_MISSING)).toBe('/tmp/tmux-1000/default');
    expect(parseTmuxSocketPathFromMessage('no server running on /tmp/x')).toBeNull();
  });

  test('pid 必须是正整数', () => {
    expect(parseTmuxServerPid('2064\n')).toBe(2064);
    expect(parseTmuxServerPid('0')).toBeNull();
    expect(parseTmuxServerPid('-3')).toBeNull();
    expect(parseTmuxServerPid('abc')).toBeNull();
    expect(parseTmuxServerPid(null)).toBeNull();
  });

  test('恢复脚本先按 0700 建父目录再发 SIGUSR1，路径带引号', () => {
    expect(buildSocketRecoveryScript('/tmp/tmux 1000/default', 2064)).toBe(
      "mkdir -p -m 700 '/tmp/tmux 1000' && kill -USR1 2064"
    );
  });
});

describe('TmuxSocketRecovery', () => {
  test('控制通道取 pid、补目录、发信号、轮询到可连即成功', async () => {
    const harness = createRecovery({});
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(true);
    expect(harness.controlWrites).toEqual(['display-message -p "#{pid}"']);
    expect(harness.scripts).toEqual(["mkdir -p -m 700 '/tmp/tmux-1000' && kill -USR1 2064"]);
    expect(harness.probes).toEqual([['display-message', '-p', '#{pid}']]);
  });

  test('消息里没有路径时回退到 #{socket_path} 查询', async () => {
    const harness = createRecovery({ socketPathReply: '/run/user/1000/tmux/default' });
    expect(await harness.recovery.recreate('error connecting (No such file or directory)')).toBe(
      true
    );
    expect(harness.controlWrites).toEqual([
      'display-message -p "#{pid}"',
      'display-message -p "#{socket_path}"',
    ]);
    expect(harness.scripts[0]).toBe("mkdir -p -m 700 '/run/user/1000/tmux' && kill -USR1 2064");
  });

  test('没有控制通道就不尝试（socket 不可达时无法再起 tmux 问 pid）', async () => {
    const harness = createRecovery({ pidReply: null });
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.scripts).toEqual([]);
  });

  test('pid 非法时不发信号', async () => {
    const harness = createRecovery({ pidReply: 'none' });
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.scripts).toEqual([]);
  });

  test('建目录/发信号失败则直接放弃，不再轮询', async () => {
    const harness = createRecovery({ shellExitCode: 1 });
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.probes).toEqual([]);
  });

  test('轮询到超时仍连不上则失败', async () => {
    const harness = createRecovery({ probeResults: [] });
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.probes.length).toBeGreaterThan(0);
  });

  test('30 s 内至多尝试一次', async () => {
    let now = 1_000_000;
    const harness = createRecovery({ now: () => now });
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(true);
    expect(harness.scripts.length).toBe(1);

    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.scripts.length).toBe(1);

    now += 30_001;
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(true);
    expect(harness.scripts.length).toBe(2);
  });

  test('并发调用共用同一次尝试：只发一次 SIGUSR1，后到者拿到同一结果', async () => {
    const now = 1_000_000;
    const harness = createRecovery({ now: () => now });
    // 两次调用都在第一次的第一个 await 之前发出，正是进节点时 select-window / resize-window 的形态。
    const first = harness.recovery.recreate(SOCKET_MISSING);
    const second = harness.recovery.recreate(SOCKET_MISSING);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(harness.scripts.length).toBe(1);

    // 这次尝试已经结束：30 s 内再来的调用仍然被限流拦住（死循环闸不变）。
    expect(await harness.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(harness.scripts.length).toBe(1);
  });

  test('连接已断或用户主动断开时不尝试', async () => {
    const offline = createRecovery({});
    offline.host.connected = false;
    expect(await offline.recovery.recreate(SOCKET_MISSING)).toBe(false);

    const manual = createRecovery({});
    manual.host.manualDisconnect = true;
    expect(await manual.recovery.recreate(SOCKET_MISSING)).toBe(false);
    expect(manual.scripts).toEqual([]);
  });
});

describe('retryAfterSocketRecovery', () => {
  function retryHost(overrides: {
    recovered?: boolean;
    retry?: CommandResult;
    connected?: boolean;
  }) {
    const calls: string[][] = [];
    const recoveries: string[] = [];
    return {
      calls,
      recoveries,
      host: {
        deviceId: 'dev-1',
        logPrefix: '[test]',
        connected: overrides.connected ?? true,
        manualDisconnect: false,
        recreateTmuxSocket: async (message: string) => {
          recoveries.push(message);
          return overrides.recovered ?? true;
        },
        runTmuxAllowFailure: async (argv: string[]) => {
          calls.push(argv);
          return overrides.retry ?? ok('ok');
        },
      },
    };
  }

  test('恢复成功后原样重试一次并返回结果', async () => {
    const { host, calls, recoveries } = retryHost({});
    const result = await retryAfterSocketRecovery(
      host,
      ['select-window', '-t', '@1'],
      SOCKET_MISSING,
      10_000
    );
    expect(result?.exitCode).toBe(0);
    expect(recoveries).toEqual([SOCKET_MISSING]);
    expect(calls).toEqual([['select-window', '-t', '@1']]);
  });

  test('重试仍失败则交回原失败路径', async () => {
    const { host } = retryHost({ retry: fail(SOCKET_MISSING) });
    expect(
      await retryAfterSocketRecovery(host, ['select-window'], SOCKET_MISSING, 10_000)
    ).toBeNull();
  });

  test('恢复失败则不重试', async () => {
    const { host, calls } = retryHost({ recovered: false });
    expect(
      await retryAfterSocketRecovery(host, ['select-window'], SOCKET_MISSING, 10_000)
    ).toBeNull();
    expect(calls).toEqual([]);
  });

  // 进节点并发打出的两条一次性命令：后到的那条必须等同一次恢复并重试，而不是被限流丢掉后报错。
  test('并发的两条命令共用一次恢复，都被重试且都不落回上报路径', async () => {
    const now = 1_000_000;
    const harness = createRecovery({ now: () => now });
    const calls: string[][] = [];
    const host = {
      deviceId: 'dev-1',
      logPrefix: '[test]',
      connected: true,
      manualDisconnect: false,
      recreateTmuxSocket: (message: string) => harness.recovery.recreate(message),
      runTmuxAllowFailure: async (argv: string[]) => {
        calls.push(argv);
        return ok('ok');
      },
    };

    const [selectResult, resizeResult] = await Promise.all([
      retryAfterSocketRecovery(host, ['select-window', '-t', '@1'], SOCKET_MISSING, 10_000),
      retryAfterSocketRecovery(
        host,
        ['resize-window', '-t', '@1', '-x', '120', '-y', '40'],
        SOCKET_MISSING,
        10_000
      ),
    ]);

    expect(selectResult?.exitCode).toBe(0);
    expect(resizeResult?.exitCode).toBe(0);
    expect(calls.map((argv) => argv[0])).toEqual(['select-window', 'resize-window']);
    expect(harness.scripts.length).toBe(1);
  });

  test('非 socket 失败与已断开的连接都不触发恢复', async () => {
    const other = retryHost({});
    expect(
      await retryAfterSocketRecovery(other.host, ['select-window'], 'no server running', 10_000)
    ).toBeNull();
    expect(other.recoveries).toEqual([]);

    const offline = retryHost({ connected: false });
    expect(
      await retryAfterSocketRecovery(offline.host, ['select-window'], SOCKET_MISSING, 10_000)
    ).toBeNull();
    expect(offline.recoveries).toEqual([]);
  });
});
