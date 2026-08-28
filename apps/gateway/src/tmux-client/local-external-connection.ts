import { homedir } from 'node:os';
import type { Device } from '@tmex/shared';
import { config } from '../config';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { connectionAlertNotifier } from '../push/connection-alerts';
import { isManagedExternally } from '../system/managed';
import {
  buildLocalTmuxEnv,
  getLocalParkingCommand,
  getLocalShellPath,
} from '../tmux/local-shell-path';
import type { TmuxConnectionOptions } from './connection-types';
import { ControlModeCommandQueue } from './control-mode-capture';
import {
  type ControlModeSubscription,
  createControlModeSubscription,
} from './control-mode-subscription';
import type { ControlStreamMetricsSnapshot } from './control-stream-metrics';
import {
  CONTROL_MAX_RESTARTS,
  CONTROL_RESTART_DELAY_MS,
  CONTROL_STABLE_RESET_MS,
  CONTROL_STDERR_TAIL_LIMIT,
  type CommandResult,
  type ExternalControlHandle,
  ExternalTmuxConnectionCore,
} from './external-tmux-core';
import { buildEnsureGhosttyTerminfoScript } from './ghostty-terminfo';
import { encodeBytesToHexChunks } from './input-encoder';
import {
  isControlModeSupported,
  parseTmuxVersion,
  tmuxClientMatchesServer,
  tmuxVersionIdentity,
} from './tmux-version';

export interface ControlClientProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
  write: (data: string) => void;
}

interface LocalExternalTmuxConnectionDeps {
  enableSubscription: boolean;
  platform: NodeJS.Platform;
  getDevice: (deviceId: string) => Device | null;
  run: (argv: string[]) => Promise<CommandResult>;
  ensureGhosttyTerminfo: () => Promise<boolean>;
  parkingCommand: () => string;
  spawnControlClient: (argv: string[]) => ControlClientProcess;
}

export function shouldIgnoreReaderAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeError = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };

  return (
    maybeError.name === 'AbortError' &&
    maybeError.code === 'ERR_STREAM_RELEASE_LOCK' &&
    typeof maybeError.message === 'string' &&
    maybeError.message.includes('releaseLock')
  );
}

const TRANSIENT_SPAWN_ERROR_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);
const TMUX_SPAWN_UNAVAILABLE_EXIT = -2;

function isTransientSpawnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_SPAWN_ERROR_CODES.has(code)) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    (message.includes('EAGAIN') ||
      message.includes('posix_spawn') ||
      message.includes('resource temporarily unavailable') ||
      message.includes('Too many open files'))
  );
}

export function defaultRun(argv: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const subprocess = Bun.spawn(argv, {
      env: buildLocalTmuxEnv(getLocalShellPath()),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
      .then(([stdout, stderr, exitCode]) => {
        resolve({ stdout, stderr, exitCode });
      })
      .catch(reject);
  });
}

export function defaultSpawnControlClient(argv: string[]): ControlClientProcess {
  const subprocess = Bun.spawn(argv, {
    env: buildLocalTmuxEnv(getLocalShellPath()),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdin = subprocess.stdin;
  return {
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    exited: subprocess.exited,
    kill: () => {
      try {
        stdin?.end();
      } catch {
        /* ignore */
      }
      subprocess.kill();
    },
    write: (data) => {
      try {
        stdin?.write(data);
      } catch {}
    },
  };
}

export function buildLocalTmuxArgv(
  argv: readonly string[],
  tmuxBin = config.tmuxBin,
  tmuxSocket = config.tmuxSocket
): string[] {
  return [tmuxBin, ...(tmuxSocket ? ['-L', tmuxSocket] : []), ...argv];
}

export class LocalExternalTmuxConnection extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[local]';
  protected readonly stalledControlLabel = 'process';

  private readonly deps: LocalExternalTmuxConnectionDeps;
  private inputTransition: Promise<void> = Promise.resolve();
  private controlProcess: ControlClientProcess | null = null;
  private spawnUnavailableNotified = false;

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<LocalExternalTmuxConnectionDeps> = {}
  ) {
    const platform = inputDeps.platform ?? process.platform;
    const getDevice = inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId));
    super(options, getDevice);
    this.deps = {
      enableSubscription: inputDeps.enableSubscription ?? true,
      platform,
      getDevice,
      run: inputDeps.run ?? defaultRun,
      ensureGhosttyTerminfo:
        inputDeps.ensureGhosttyTerminfo ??
        (async () => {
          if (platform === 'win32') {
            return false;
          }
          const result = await this.deps.run(['/bin/sh', '-c', buildEnsureGhosttyTerminfoScript()]);
          return result.exitCode === 0;
        }),
      parkingCommand: inputDeps.parkingCommand ?? (() => getLocalParkingCommand(platform)),
      spawnControlClient: inputDeps.spawnControlClient ?? defaultSpawnControlClient,
    };
  }

  async connect(): Promise<void> {
    await this.runConnectAttempt(async (generation) => {
      this.device = this.deps.getDevice(this.deviceId);
      if (!this.device) {
        throw new Error(`Device not found: ${this.deviceId}`);
      }
      if (this.device.type !== 'local') {
        throw new Error(`LocalExternalTmuxConnection only supports local device: ${this.deviceId}`);
      }

      this.sessionName = this.device.session?.trim() || 'tmex';

      await this.awaitConnectStep(generation, () => this.assertTmuxCompatibility());
      const { created } = await this.awaitConnectStep(generation, () => this.ensureSession());
      await this.finalizeConnect(generation, created, this.deps.enableSubscription);
    });
  }

  disconnect(): void {
    this.invalidateConnectGeneration();
    if (!this.connected && this.manualDisconnect) {
      return;
    }

    this.manualDisconnect = true;
    this.connected = false;
    this.stopControlClient();
  }

  sendInput(paneId: string, data: string): void {
    this.enqueueInputBytes(paneId, new TextEncoder().encode(data));
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    this.enqueueInputBytes(paneId, Uint8Array.from(data));
  }

  protected resolveDefaultWorkingDir(): string {
    return this.device?.defaultWorkingDir?.trim() || homedir();
  }

  protected async runTmuxAllowFailure(argv: string[]): Promise<CommandResult> {
    try {
      return await this.deps.run(buildLocalTmuxArgv(argv));
    } catch (error) {
      if (isTransientSpawnError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        return { exitCode: TMUX_SPAWN_UNAVAILABLE_EXIT, stdout: '', stderr: message };
      }
      throw error;
    }
  }

  protected getParkingCommand(): string {
    return this.deps.parkingCommand();
  }

  protected async shouldInstallGhosttyTerminfo(): Promise<boolean> {
    return this.deps.platform !== 'win32' && (await this.deps.ensureGhosttyTerminfo());
  }

  protected async attachControlTransport(
    onAttachReady: () => void
  ): Promise<ExternalControlHandle> {
    if (this.manualDisconnect) {
      throw new Error(this.controlAttachFailureMessage());
    }
    return this.spawnControlClientProcess(onAttachReady);
  }

  protected isAttachedControlTransport(transport: ExternalControlHandle): boolean {
    return this.controlProcess === transport;
  }

  protected getControlWriter(): ((data: string) => void) | null {
    const control = this.controlProcess;
    return control ? (data) => control.write(data) : null;
  }

  protected detachControlTransport(): () => void {
    const proc = this.controlProcess;
    this.controlProcess = null;
    return () => proc?.kill();
  }

  protected killControlTransport(): void {
    this.controlProcess?.kill();
  }

  protected controlAttachFailureMessage(): string {
    return 'tmux control client exited during attach';
  }

  protected onControlAttachPrematureClose(message: string): void {
    console.warn(`[local] tmux control client died during attach on ${this.deviceId}: ${message}`);
  }

  protected reportTmuxCommandFailure(message: string): void {
    void this.notifyRuntimeError(message);
  }

  protected onTmuxServerGone(message: string): void {
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
  }

  protected async runHistoryQuery(argv: string[]): Promise<CommandResult> {
    return this.runTmux(argv, 'silent');
  }

  protected async runHistoryCapture(argv: string[], maxOutputBytes: number): Promise<string> {
    const { stdout } = await this.runTmux(argv, 'silent');
    if (new TextEncoder().encode(stdout).byteLength > maxOutputBytes) {
      throw new Error('tmux history capture exceeded bounded output');
    }
    return stdout;
  }

  protected shouldAbortSnapshot(results: CommandResult[]): boolean {
    const transientResult = results.find((res) => res.exitCode === TMUX_SPAWN_UNAVAILABLE_EXIT);
    if (transientResult) {
      this.handleSpawnUnavailable(transientResult.stderr);
      return true;
    }
    return false;
  }

  protected onSnapshotSuccess(): void {
    this.markSpawnRecovered();
  }

  protected override handleSnapshotFailure(error: unknown): void {
    if (isTransientSpawnError(error)) {
      this.handleSpawnUnavailable(error instanceof Error ? error.message : String(error));
      return;
    }
    this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
  }

  private enqueueInputBytes(paneId: string, data: Uint8Array): void {
    if (!this.connected) {
      return;
    }

    const task = async () => {
      for (const chunk of encodeBytesToHexChunks(data)) {
        const control = this.controlProcess;
        if (control) {
          await this.controlCommands.execute(
            (command) => control.write(command),
            ['send-keys', '-H', '-t', paneId, ...chunk].join(' '),
            { transform: () => undefined }
          );
        } else {
          await this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]);
        }
      }
    };

    const next = this.inputTransition.catch(() => undefined).then(task);
    this.inputTransition = next;
    void next.catch((error) => {
      this.callbacks.onError(error);
    });
  }

  private async assertTmuxCompatibility(): Promise<void> {
    const result = await this.runTmuxAllowFailure(['-V']);
    if (result.exitCode !== 0) {
      if (config.tmuxBin !== 'tmux') {
        throw new Error(
          `configured tmux executable is unavailable: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        );
      }
      return;
    }
    const version = parseTmuxVersion(result.stdout.trim());
    if (this.deps.enableSubscription && !isControlModeSupported(version)) {
      throw new Error(
        `tmux ${version?.major}.${version?.minor} is too old for tmex (control mode requires tmux >= 3.0)`
      );
    }
    if (config.tmuxBin !== 'tmux') {
      const server = await this.runTmuxAllowFailure(['display-message', '-p', '#{version}']);
      if (
        server.exitCode === 0 &&
        server.stdout.trim() &&
        !tmuxClientMatchesServer(result.stdout, server.stdout)
      ) {
        const clientVersion = tmuxVersionIdentity(result.stdout) ?? 'unknown';
        const serverVersion = tmuxVersionIdentity(server.stdout) ?? 'unknown';
        throw new Error(
          `tmux client ${clientVersion} does not match existing server ${serverVersion}; refusing to modify the session`
        );
      }
    }
  }

  private spawnControlClientProcess(onAttachReady: () => void): ControlClientProcess {
    this.controlCommands.dispose('tmux control connection replaced');
    let proc: ControlClientProcess | null = null;
    const controlCommands = new ControlModeCommandQueue(() => proc?.kill());
    this.controlCommands = controlCommands;
    const metricsOptions = isManagedExternally()
      ? {
          onMetrics: (metrics: ControlStreamMetricsSnapshot) => {
            console.log(
              `[tmux-metrics] control_stream interval_ms=${metrics.intervalMs} ` +
                `raw_chunks=${metrics.rawChunks} raw_bytes=${metrics.rawBytes} ` +
                `control_outputs=${metrics.controlOutputs} ` +
                `control_output_bytes=${metrics.controlOutputBytes} ` +
                `terminal_outputs=${metrics.terminalOutputs} ` +
                `terminal_output_bytes=${metrics.terminalOutputBytes} ` +
                `titles=${metrics.titles} bells=${metrics.bells} ` +
                `notifications=${metrics.notifications} ` +
                `structure_changes=${metrics.structureChanges} blocks=${metrics.blocks}`
            );
          },
        }
      : undefined;
    const subscription = createControlModeSubscription(
      this.buildControlModeCallbacks(
        onAttachReady,
        controlCommands,
        (data) => {
          proc?.write(data);
        },
        () => this.controlProcess === proc
      ),
      metricsOptions
    );

    proc = this.deps.spawnControlClient(
      buildLocalTmuxArgv(['-C', 'attach-session', '-t', this.sessionName])
    );
    this.controlProcess = proc;
    this.controlSubscription = subscription;
    this.controlStartedAt = Date.now();
    this.controlStderrTail = '';

    void this.pumpControlStdout(proc, subscription);
    void this.pumpControlStderr(proc);
    void proc.exited
      .then((exitCode) => {
        this.handleControlClientExit(proc, exitCode);
      })
      .catch(() => {
        this.handleControlClientExit(proc, -1);
      });
    return proc;
  }

  private async pumpControlStdout(
    proc: ControlClientProcess,
    subscription: ControlModeSubscription
  ): Promise<void> {
    const reader = proc.stdout.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done || this.controlProcess !== proc) {
          break;
        }
        subscription.push(chunk.value);
      }
    } catch (error) {
      if (!this.manualDisconnect && !shouldIgnoreReaderAbortError(error)) {
        this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
    subscription.end();
    if (this.controlProcess === proc) {
      console.warn(
        `[local] control client stdout ended unexpectedly on ${this.deviceId}, killing process`
      );
      proc.kill();
    }
  }

  private async pumpControlStderr(proc: ControlClientProcess): Promise<void> {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        if (this.controlProcess === proc) {
          this.controlStderrTail = (this.controlStderrTail + decoder.decode(chunk.value)).slice(
            -CONTROL_STDERR_TAIL_LIMIT
          );
        }
      }
    } catch {
      /* stderr 噪声不影响主流程 */
    }
  }

  private handleControlClientExit(proc: ControlClientProcess, exitCode: number): void {
    if (this.controlProcess !== proc) {
      return;
    }
    this.controlProcess = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    if (!this.connected || this.manualDisconnect) {
      return;
    }
    void this.reconnectControlClient(exitCode);
  }

  private async reconnectControlClient(exitCode: number): Promise<void> {
    if (Date.now() - this.controlStartedAt > CONTROL_STABLE_RESET_MS) {
      this.controlRestartCount = 0;
    }
    this.controlRestartCount += 1;
    const stderrMessage = this.controlStderrTail.trim();

    if (this.controlRestartCount > CONTROL_MAX_RESTARTS) {
      const message =
        stderrMessage || `tmux control client exited repeatedly (last code ${exitCode})`;
      console.warn(`[local] tmux control client gave up on ${this.deviceId}: ${message}`);
      void this.notifyRuntimeError(message);
      void this.shutdownInternal(true);
      return;
    }

    console.warn(
      `[local] tmux control client exited (code ${exitCode}) on ${this.deviceId}, reconnecting (attempt ${this.controlRestartCount})`
    );
    await new Promise((resolve) =>
      setTimeout(resolve, CONTROL_RESTART_DELAY_MS * this.controlRestartCount)
    );
    if (!this.connected || this.manualDisconnect) {
      return;
    }

    const probe = await this.runTmuxAllowFailure(['has-session', '-t', this.sessionName]);
    if (probe.exitCode === TMUX_SPAWN_UNAVAILABLE_EXIT) {
      this.handleSpawnUnavailable(probe.stderr);
      this.controlRestartCount = Math.max(0, this.controlRestartCount - 1);
      if (this.connected && !this.manualDisconnect) {
        setTimeout(() => {
          void this.reconnectControlClient(exitCode);
        }, CONTROL_RESTART_DELAY_MS * 4);
      }
      return;
    }
    if (probe.exitCode !== 0) {
      const message = probe.stderr.trim() || probe.stdout.trim() || 'tmux session gone';
      console.warn(`[local] tmux session gone on ${this.deviceId}: ${message}`);
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      this.lifecycle.notifySessionClosed(message);
      void this.shutdownInternal(true);
      return;
    }
    if (!this.connected || this.manualDisconnect) {
      return;
    }

    try {
      await this.startControlClient();
    } catch (error) {
      console.warn(`[local] control client restart failed on ${this.deviceId}:`, error);
      return;
    }
    this.requestSnapshot();
    if (this.activePaneId) {
      void this.capturePaneHistory(this.activePaneId).catch(() => undefined);
    }
  }

  private async notifyRuntimeError(message: string): Promise<void> {
    const device = getDeviceById(this.deviceId);
    if (!device) {
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      return;
    }
    await connectionAlertNotifier.notify({
      device,
      error: new Error(message),
      source: 'runtime',
      silentTelegram: true,
    });
  }

  private handleSpawnUnavailable(message: string): void {
    if (this.spawnUnavailableNotified) {
      return;
    }
    this.spawnUnavailableNotified = true;
    const detail = (message || 'tmux spawn unavailable (process table exhausted)').trim();
    console.warn(
      `[local] tmux spawn unavailable on ${this.deviceId} (process pressure), degrading without shutdown: ${detail}`
    );
    void this.notifyRuntimeError(detail);
  }

  private markSpawnRecovered(): void {
    this.spawnUnavailableNotified = false;
  }
}
