import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import type { Device } from '@tmex/shared';

import { runMigrations } from '../../db/migrate';
import { createDeviceSessionRuntime } from '../../tmux-client/device-session-runtime';
import {
  LocalExternalTmuxConnection,
  defaultRun,
  defaultSpawnControlClient,
} from '../../tmux-client/local-external-connection';
import { PaneEmulatorRegistry } from '../../tmux-client/pane-emulator';
import type { PromptMarker } from '../../tmux-client/pane-stream-parser';
import type { RunCommandResult } from './run-command';
import { OUTPUT_MAX_BYTES } from './run-command-buffer';
import { createTerminalTools } from './terminal';

const NOW = '2026-09-03T00:00:00.000Z';
const DEVICE_ID = 'device-runcmd-e2e';
const VIEWPORT_ROWS = 24;
const VIEWPORT_COLS = 200;
const LONG_LINE_COUNT = 3000;
const FIRST_MARKER = 'RC_E2E_FIRST';
const LAST_MARKER = 'RC_E2E_LAST';
const CASE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 180_000;
const execOptions = { toolCallId: 'call-1', messages: [] };

const LONG_OUTPUT_COMMAND =
  `echo ${FIRST_MARKER}; i=1; while [ "$i" -le ${LONG_LINE_COUNT} ]; ` +
  `do echo "$i"; i=$((i+1)); done; echo ${LAST_MARKER}`;

// 独立临时 socket（-L），不触碰默认 socket / 名为 tmex 的会话。
function socketArgs(socketName: string, argv: string[]): string[] {
  return argv[0] === 'tmux' ? ['tmux', '-L', socketName, ...argv.slice(1)] : argv;
}

function socketDeps(socketName: string) {
  return {
    run: (argv: string[]) => defaultRun(socketArgs(socketName, argv)),
    spawnControlClient: (argv: string[]) => defaultSpawnControlClient(socketArgs(socketName, argv)),
  };
}

function tmuxOn(socketName: string, command: string): string {
  return execSync(`tmux -L ${socketName} ${command}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function cleanupSocket(socketName: string): void {
  try {
    execSync(`tmux -L ${socketName} kill-server`, { stdio: 'ignore' });
  } catch {
    // server 已退出则忽略
  }
  execSync(`rm -f "\${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${socketName}"`, { stdio: 'ignore' });
}

function createLocalDevice(session: string): Device {
  return {
    id: DEVICE_ID,
    name: 'local-runcmd-e2e',
    type: 'local',
    authMode: 'auto',
    session,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function waitFor<T>(
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 15_000,
  label = 'waitFor'
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value !== null && value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(50);
  }
  const extra = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} timeout after ${timeoutMs}ms${extra}`);
}

function commandOnPath(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveTuiCommand(): { command: string; quit: string; name: string } | null {
  if (commandOnPath('vim')) {
    return { command: 'vim -Nu NONE -n', quit: '\x1b:q!\r', name: 'vim' };
  }
  if (commandOnPath('less')) {
    return { command: 'LESS= less -n /etc/hosts', quit: 'q', name: 'less' };
  }
  return null;
}

type ExecutableTool = {
  execute: (input: unknown, options: unknown) => Promise<unknown>;
};

function unwrapTerminalOutput(wrapped: string): string {
  const start = wrapped.indexOf('\n');
  const end = wrapped.lastIndexOf('\n');
  if (start < 0 || end <= start) {
    return wrapped;
  }
  return wrapped.slice(start + 1, end);
}

function asRunCommandResult(value: unknown): RunCommandResult {
  if (!value || typeof value !== 'object') {
    throw new Error(`run_command returned non-object: ${String(value)}`);
  }
  const record = value as { error?: unknown; status?: unknown };
  if (typeof record.error === 'string' && record.status === undefined) {
    throw new Error(`run_command failed: ${record.error}`);
  }
  return value as RunCommandResult;
}

async function invokeRunCommand(
  tools: ReturnType<typeof createTerminalTools>,
  command: string
): Promise<RunCommandResult> {
  const tool = tools.run_command as unknown as ExecutableTool;
  expect(tool).toBeDefined();
  const raw = await tool.execute(
    { command, mode: 'posix', shell: 'sh', timeoutMs: CASE_TIMEOUT_MS },
    execOptions
  );
  return asRunCommandResult(raw);
}

let leftoverSocket: string | null = null;

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  if (leftoverSocket) {
    cleanupSocket(leftoverSocket);
    leftoverSocket = null;
  }
});

describe('run_command real tmux integration', () => {
  test(
    'control-mode → parser → PaneEmulator → run_command (long output, exit codes, TUI)',
    async () => {
      const socketName = `tmex-test-runcmd-${process.pid}-${Date.now()}`;
      const sessionName = `runcmd-e2e-${process.pid}`;
      leftoverSocket = socketName;
      expect(sessionName).not.toBe('tmex');

      tmuxOn(
        socketName,
        `new-session -d -x ${VIEWPORT_COLS} -y ${VIEWPORT_ROWS} -s ${sessionName} "sh -lc 'echo READY_MARKER; exec sh'"`
      );
      tmuxOn(socketName, `set-environment -t ${sessionName} TERM xterm-256color`);

      const registry = new PaneEmulatorRegistry();
      const outputByPane = new Map<string, string>();
      const promptMarkers: Array<{ paneId: string; marker: PromptMarker }> = [];
      const decoder = new TextDecoder();

      const runtime = createDeviceSessionRuntime({
        deviceId: DEVICE_ID,
        createConnection: (options) =>
          new LocalExternalTmuxConnection(options, {
            getDevice: () => createLocalDevice(sessionName),
            ...socketDeps(socketName),
          }),
      });

      runtime.subscribe({
        onTerminalOutput: (paneId, data) => {
          if (data.byteLength === 0) {
            return;
          }
          outputByPane.set(
            paneId,
            `${outputByPane.get(paneId) ?? ''}${decoder.decode(data, { stream: true })}`
          );
        },
        onPromptMarker: (paneId, marker) => {
          promptMarkers.push({ paneId, marker });
        },
      });

      let emulatorReleased = false;
      let paneId: string | null = null;

      try {
        await runtime.connect();

        const snapshot = await waitFor(
          () => runtime.getCurrentSnapshot()?.session ?? null,
          15_000,
          'runtime snapshot'
        );
        const windowId = snapshot.windows[0]?.id ?? null;
        paneId = snapshot.windows[0]?.panes[0]?.id ?? null;
        expect(windowId).toBeTruthy();
        expect(paneId).toBeTruthy();
        if (!windowId || !paneId) {
          throw new Error('snapshot missing active pane');
        }
        const boundPaneId = paneId;

        await waitFor(() => runtime.getPaneIdentity(boundPaneId), 15_000, 'pane identity');

        runtime.selectPaneWithSize(windowId, boundPaneId, VIEWPORT_COLS, VIEWPORT_ROWS);
        await waitFor(
          async () => {
            const info = await runtime.getPaneInfo(boundPaneId);
            return info.cols >= 80 && info.rows > 0 ? info : null;
          },
          10_000,
          'pane size'
        );

        const emulator = await registry.acquire(DEVICE_ID, boundPaneId, runtime);
        const tools = createTerminalTools({
          paneId: boundPaneId,
          deviceId: DEVICE_ID,
          getRuntime: () => runtime,
          getEmulator: () => emulator,
          isRuntimeAlive: () => !runtime.isTerminated,
          needsApprovalForWrite: false,
          onFailure: () => {},
          onSuccess: () => {},
        });

        const longResult = await invokeRunCommand(tools, LONG_OUTPUT_COMMAND);
        expect(longResult.status).toBe('completed');
        expect(longResult.exitCode).toBe(0);
        expect(longResult.truncated).toBe(false);
        const longBody = unwrapTerminalOutput(longResult.output);
        expect(longBody).toContain(FIRST_MARKER);
        expect(longBody).toContain(LAST_MARKER);
        const longLines = longBody.split('\n');
        expect(longLines).toContain('1');
        expect(longLines).toContain(String(LONG_LINE_COUNT));
        expect(longLines.length).toBeGreaterThan(VIEWPORT_ROWS);
        expect(Buffer.byteLength(longBody, 'utf8')).toBeLessThan(OUTPUT_MAX_BYTES);

        const paneOutput = outputByPane.get(boundPaneId) ?? '';
        expect(paneOutput.length).toBeGreaterThan(0);
        expect(paneOutput).toContain(FIRST_MARKER);
        expect(paneOutput).toContain(LAST_MARKER);

        const dMarkers = promptMarkers.filter(
          (item) => item.paneId === boundPaneId && item.marker.kind === 'D'
        );
        expect(dMarkers.some((item) => item.marker.exitCode === 0)).toBe(true);
        expect(
          dMarkers.some((item) => item.marker.params.some((param) => param.startsWith('tmex=')))
        ).toBe(true);

        const falseResult = await invokeRunCommand(tools, 'false');
        expect(falseResult.status).toBe('completed');
        expect(falseResult.exitCode).toBe(1);
        expect(falseResult.truncated).toBe(false);
        expect(
          promptMarkers.some(
            (item) =>
              item.paneId === boundPaneId && item.marker.kind === 'D' && item.marker.exitCode === 1
          )
        ).toBe(true);

        const tui = resolveTuiCommand();
        if (!tui) {
          console.warn('skipping TUI sub-case: neither vim nor less is available on PATH');
        } else {
          expect(emulator.isAlternateScreen()).toBe(false);
          const tuiResult = await invokeRunCommand(tools, tui.command);
          expect(tuiResult.status).toBe('entered_tui');
          expect(tuiResult.exitCode).toBeNull();
          expect(tuiResult.truncated).toBe(false);
          runtime.sendInput(boundPaneId, tui.quit);
          await waitFor(
            () => (emulator.isAlternateScreen() ? null : true),
            10_000,
            `${tui.name} leave alternate screen`
          );
        }

        await registry.release(DEVICE_ID, boundPaneId);
        emulatorReleased = true;
      } finally {
        if (!emulatorReleased && paneId) {
          await registry.release(DEVICE_ID, paneId).catch(() => undefined);
        }
        await registry.shutdownAll().catch(() => undefined);
        runtime.disconnect();
        cleanupSocket(socketName);
        leftoverSocket = null;
      }
    },
    TEST_TIMEOUT_MS
  );
});
