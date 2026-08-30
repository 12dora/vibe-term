import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

import * as db from '../db';
import { runMigrations } from '../db/migrate';
import type { CommandResult } from './external/types';
import {
  CONTROL_RECONNECT_POLICY,
  type ControlReconnectHost,
  reconnectControlChannel,
} from './reconnect-control-channel';

const policy = {
  maxRestarts: 3,
  restartDelayMs: 10,
  stableResetMs: 1000,
} as const;

function result(exitCode: number, stderr = '', stdout = ''): CommandResult {
  return { exitCode, stderr, stdout };
}

function createHost(
  overrides: Partial<ControlReconnectHost> & {
    probe?: CommandResult | (() => Promise<CommandResult>);
    start?: () => Promise<void>;
    capture?: (paneId: string) => Promise<unknown>;
  } = {}
): ControlReconnectHost & {
  sessionGone: string[];
  snapshots: number;
  captured: string[];
  shutdowns: boolean[];
} {
  const sessionGone: string[] = [];
  const captured: string[] = [];
  const shutdowns: boolean[] = [];
  let snapshots = 0;
  const host: ControlReconnectHost & {
    sessionGone: string[];
    snapshots: number;
    captured: string[];
    shutdowns: boolean[];
  } = {
    controlStartedAt: 0,
    controlRestartCount: 0,
    controlStderrTail: '',
    connected: true,
    manualDisconnect: false,
    activePaneId: '%1',
    sessionName: 'tmex',
    deviceId: 'dev-1',
    logPrefix: '[local]',
    runTmuxAllowFailure: async () => {
      const probe = overrides.probe;
      if (typeof probe === 'function') return probe();
      return probe ?? result(0);
    },
    startControlClient: overrides.start ?? (async () => undefined),
    requestSnapshot: () => {
      snapshots += 1;
      host.snapshots = snapshots;
    },
    capturePaneHistory: async (paneId) => {
      captured.push(paneId);
      await overrides.capture?.(paneId);
    },
    lifecycle: {
      notifySessionClosed: (message) => {
        sessionGone.push(message);
      },
    },
    shutdownInternal: async (notifyClose) => {
      shutdowns.push(notifyClose);
    },
    sessionGone,
    snapshots: 0,
    captured,
    shutdowns,
    ...overrides,
  };
  return host;
}

beforeAll(() => {
  runMigrations();
});

describe('reconnectControlChannel', () => {
  test('resets restart count after the stable window then restarts and resyncs', async () => {
    const delays: number[] = [];
    const host = createHost({
      controlStartedAt: 0,
      controlRestartCount: 2,
    });
    const attempts: number[] = [];

    await reconnectControlChannel(policy, {
      host,
      now: () => 1001,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onGaveUp: () => {
        throw new Error('should not give up');
      },
      onAttempt: (count) => {
        attempts.push(count);
      },
      classifyProbe: (probe) => (probe.exitCode === 0 ? 'alive' : 'gone'),
    });

    expect(host.controlRestartCount).toBe(1);
    expect(attempts).toEqual([1]);
    expect(delays).toEqual([10]);
    expect(host.snapshots).toBe(1);
    expect(host.captured).toEqual(['%1']);
  });

  test('gives up without sleeping once restarts exceed the policy cap', async () => {
    const host = createHost({
      controlStartedAt: 500,
      controlRestartCount: 3,
      controlStderrTail: ' broken pipe \n',
    });
    const gaveUp: string[] = [];
    let slept = false;

    await reconnectControlChannel(policy, {
      host,
      now: () => 500,
      sleep: async () => {
        slept = true;
      },
      onGaveUp: (stderr) => {
        gaveUp.push(stderr);
      },
      onAttempt: () => {
        throw new Error('should not attempt');
      },
      classifyProbe: () => 'alive',
    });

    expect(host.controlRestartCount).toBe(4);
    expect(gaveUp).toEqual(['broken pipe']);
    expect(slept).toBe(false);
    expect(host.snapshots).toBe(0);
  });

  test('returns after the delay when the connection is no longer live', async () => {
    let probed = false;
    const host = createHost({
      probe: async () => {
        probed = true;
        return result(0);
      },
    });

    await reconnectControlChannel(policy, {
      host,
      sleep: async () => {
        host.connected = false;
      },
      onGaveUp: () => {
        throw new Error('should not give up');
      },
      onAttempt: () => undefined,
      classifyProbe: () => 'alive',
      now: () => 0,
    });

    expect(probed).toBe(false);
    expect(host.snapshots).toBe(0);
  });

  test('treats a failed has-session probe as session-gone and shuts down', async () => {
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(' '));
    };
    const statusSpy = spyOn(db, 'updateDeviceRuntimeStatus').mockImplementation(() => undefined);
    const host = createHost({
      probe: result(1, "can't find session: tmex", ''),
    });
    try {
      await reconnectControlChannel(policy, {
        host,
        sleep: async () => undefined,
        onGaveUp: () => {
          throw new Error('should not give up');
        },
        onAttempt: () => undefined,
        classifyProbe: (probe) => (probe.exitCode === 0 ? 'alive' : 'gone'),
        now: () => 0,
      });
      expect(host.sessionGone).toEqual(["can't find session: tmex"]);
      expect(host.shutdowns).toEqual([true]);
      expect(host.snapshots).toBe(0);
      expect(warns.some((line) => line.includes('[local] tmux session gone on dev-1'))).toBe(true);
      expect(statusSpy).toHaveBeenCalledWith('dev-1', {
        lastSeenAt: expect.any(String),
        tmuxAvailable: false,
        lastError: "can't find session: tmex",
      });
    } finally {
      console.warn = originalWarn;
      statusSpy.mockRestore();
    }
  });

  test('returns a retry delay for adapter-classified transient probes and decrements the count', async () => {
    const host = createHost({
      probe: result(-2, 'EAGAIN'),
    });
    const classified: string[] = [];

    const retry = await reconnectControlChannel(policy, {
      host,
      sleep: async () => undefined,
      onGaveUp: () => {
        throw new Error('should not give up');
      },
      onAttempt: () => undefined,
      classifyProbe: (probe) => {
        classified.push(probe.stderr);
        return probe.exitCode === -2 ? 'retry' : 'alive';
      },
      now: () => 0,
    });

    expect(classified).toEqual(['EAGAIN']);
    expect(host.controlRestartCount).toBe(0);
    expect(retry).toEqual({ retryDelayMs: 40 });
    expect(host.snapshots).toBe(0);
  });

  test('does not capture pane history when there is no active pane', async () => {
    const host = createHost({ activePaneId: null });

    await reconnectControlChannel(policy, {
      host,
      sleep: async () => undefined,
      onGaveUp: () => {
        throw new Error('should not give up');
      },
      onAttempt: () => undefined,
      classifyProbe: () => 'alive',
      now: () => 0,
    });

    expect(host.snapshots).toBe(1);
    expect(host.captured).toEqual([]);
  });

  test('swallows startControlClient failure without snapshot resync', async () => {
    const warns: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    const host = createHost({
      start: async () => {
        throw new Error('attach failed');
      },
    });
    try {
      await reconnectControlChannel(CONTROL_RECONNECT_POLICY, {
        host,
        sleep: async () => undefined,
        onGaveUp: () => {
          throw new Error('should not give up');
        },
        onAttempt: () => undefined,
        classifyProbe: () => 'alive',
        now: () => 0,
      });
    } finally {
      console.warn = originalWarn;
    }

    expect(host.snapshots).toBe(0);
    expect(host.captured).toEqual([]);
    expect(String(warns[0]?.[0])).toContain('[local] control client restart failed on dev-1');
  });
});
