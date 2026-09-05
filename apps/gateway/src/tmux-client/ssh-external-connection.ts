import { errorMessage } from '@tmex/shared';
import type { Device } from '@tmex/shared';
import { Client, type ClientChannel } from 'ssh2';

import { config } from '../config';
import { decryptWithContext } from '../crypto';
import { getDeviceById, updateDeviceRuntimeStatus } from '../db';
import { joinShellArgs, quoteShellArg } from './command-builder';
import type { TmuxConnectionOptions } from './connection-types';
import { ControlModeCommandQueue } from './control-mode-capture';
import { createControlModeSubscription } from './control-mode-subscription';
import {
  CONTROL_STDERR_TAIL_LIMIT,
  type CommandResult,
  type ExternalControlHandle,
  ExternalTmuxConnectionCore,
} from './external-tmux-core';
import { buildEnsureGhosttyTerminfoScript } from './ghostty-terminfo';
import { buildSendKeysCommands, pipelineSendKeys } from './input-encoder';
import { appendRollingTail, decodeRollingTail } from './local-external-connection';
import {
  CONTROL_RECONNECT_POLICY,
  type ControlReconnectHost,
  reconnectControlChannel,
} from './reconnect-control-channel';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';
import { resolveSshConnectConfig } from './ssh-connect-config';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';
import { isControlModeSupported, parseTmuxVersion } from './tmux-version';
import { resolveTmuxWindowStyle } from './window-style';

interface PendingShellCommand {
  id: string;
  stderr: string;
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SshExternalTmuxConnectionDeps {
  getDevice: (deviceId: string) => Device | null;
  decrypt: typeof decryptWithContext;
  createClient: () => Client;
}

interface ControlChannelHandle extends ExternalControlHandle {
  stop: () => void;
}

const COMMAND_SENTINEL = '\x1eTMEX_END ';

export class SshExternalTmuxConnection extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[ssh]';
  protected readonly stalledControlLabel = 'channel';

  private readonly deps: SshExternalTmuxConnectionDeps;
  private controlChannel: ControlChannelHandle | null = null;
  private sshClient: Client | null = null;
  private commandStream: ClientChannel | null = null;
  private commandStdoutBuffer = '';
  private pendingCommand: PendingShellCommand | null = null;
  private tmuxBin = 'tmux';
  private remoteHomeDir = '.';
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(
    options: TmuxConnectionOptions,
    inputDeps: Partial<SshExternalTmuxConnectionDeps> = {}
  ) {
    const getDevice = inputDeps.getDevice ?? ((deviceId) => getDeviceById(deviceId));
    super(options, getDevice);
    this.deps = {
      getDevice,
      decrypt: inputDeps.decrypt ?? decryptWithContext,
      createClient: inputDeps.createClient ?? (() => new Client()),
    };
  }

  async connect(): Promise<void> {
    await this.runConnectAttempt(async (generation) => {
      this.device = this.deps.getDevice(this.deviceId);
      if (!this.device) {
        throw new Error(`Device not found: ${this.deviceId}`);
      }
      if (this.device.type !== 'ssh') {
        throw new Error(`SshExternalTmuxConnection only supports ssh device: ${this.deviceId}`);
      }

      this.sessionName = this.device.session?.trim() || 'tmex';

      await this.awaitConnectStep(generation, () => this.connectSshClient());
      await this.awaitConnectStep(generation, () => this.openCommandChannel());
      const { created } = await this.awaitConnectStep(generation, () => this.ensureSession());
      await this.finalizeConnect(generation, created, true);
    });
  }

  disconnect(): void {
    this.invalidateConnectGeneration();
    if (this.manualDisconnect) {
      return;
    }
    this.manualDisconnect = true;
    void this.shutdownInternal(false);
  }

  sendInput(paneId: string, data: string): Promise<void> {
    return this.sendInputBytes(paneId, new TextEncoder().encode(data));
  }

  sendInputBytes(paneId: string, data: Uint8Array): Promise<void> {
    if (!this.connected) {
      return Promise.resolve();
    }

    const commands = buildSendKeysCommands(paneId, data);
    const control = this.controlChannel;
    if (!control) {
      return Promise.all(commands.map((argv) => this.runTmux(argv))).then(() => undefined);
    }
    return pipelineSendKeys(commands, (command) =>
      this.controlCommands
        .execute((value) => control.write(value), command, {
          transform: () => undefined,
          timeoutMs: this.getControlCommandTimeoutMs(),
        })
        .catch((error) => {
          this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
          throw error;
        })
    );
  }

  protected resolveDefaultWorkingDir(): string {
    return this.device?.defaultWorkingDir?.trim() || this.remoteHomeDir;
  }

  protected async runTmuxAllowFailure(argv: string[], timeoutMs = 10000): Promise<CommandResult> {
    return this.runShell(`${quoteShellArg(this.tmuxBin)} ${joinShellArgs(argv)}`, timeoutMs);
  }

  protected getParkingCommand(): string {
    return 'sleep 30';
  }

  protected async shouldInstallGhosttyTerminfo(): Promise<boolean> {
    return this.ensureGhosttyTerminfo();
  }

  protected async attachControlTransport(
    onAttachReady: () => void
  ): Promise<ExternalControlHandle> {
    if (this.manualDisconnect) {
      throw new Error(this.controlAttachFailureMessage());
    }
    return this.openControlChannel(onAttachReady);
  }

  protected isAttachedControlTransport(transport: ExternalControlHandle): boolean {
    return this.controlChannel === transport;
  }

  protected getControlWriter(): ((data: string) => void) | null {
    const control = this.controlChannel;
    return control ? (data) => control.write(data) : null;
  }

  protected detachControlTransport(): () => void {
    const handle = this.controlChannel;
    this.controlChannel = null;
    return () => handle?.stop();
  }

  protected killControlTransport(): void {
    this.controlChannel?.stop();
  }

  protected controlAttachFailureMessage(): string {
    return 'tmux control client channel closed during attach';
  }

  protected reportTmuxCommandFailure(message: string): void {
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
  }

  protected async runHistoryQuery(argv: string[]): Promise<CommandResult> {
    return this.runTmuxIsolated(argv, 4096, 30_000);
  }

  protected async runHistoryCapture(argv: string[], maxOutputBytes: number): Promise<string> {
    const { stdout } = await this.runTmuxIsolated(argv, maxOutputBytes, 30_000);
    return stdout;
  }

  protected getControlCommandTimeoutMs(): number {
    return 30_000;
  }

  protected async disposeTransport(): Promise<void> {
    this.rejectPendingCommand(new Error('SSH command channel closed'));
    this.commandStream?.end();
    this.commandStream?.close();
    this.commandStream?.destroy();
    this.commandStream = null;
    this.sshClient?.end();
    this.sshClient = null;
  }

  protected async configureWindowStyle(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    const windowStyle = resolveTmuxWindowStyle(styleValue);
    if (!windowStyle) {
      return;
    }
    const startedAt = config.isDev ? Date.now() : 0;
    await this.runTmuxAllowFailure([
      'set-hook',
      '-t',
      this.sessionName,
      'after-new-window',
      `set-option -w window-style '${windowStyle}'`,
    ]);
    const windows = await this.runTmuxAllowFailure([
      'list-windows',
      '-t',
      this.sessionName,
      '-F',
      '#{window_id}',
    ]);
    if (windows.exitCode !== 0) {
      if (config.isDev) {
        console.debug(
          `[ssh] configureWindowStyle deviceId=${this.deviceId} elapsed=${Date.now() - startedAt}ms (list-windows failed)`
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
            `${quoteShellArg(this.tmuxBin)} set-option -w -t ${quoteShellArg(id)} window-style ${quoteShellArg(windowStyle)}`
        )
        .join(' && ');
      await this.runShellAllowFailure(setOptions);
    }
    if (config.isDev) {
      console.debug(
        `[ssh] configureWindowStyle deviceId=${this.deviceId} windows=${windowIds.length} elapsed=${Date.now() - startedAt}ms`
      );
    }
  }

  private async connectSshClient(): Promise<void> {
    if (!this.device) {
      throw new Error('SSH device not loaded');
    }
    const authConfig = await resolveSshConnectConfig(this.device, this.deps.decrypt);

    const client = this.deps.createClient();
    this.sshClient = client;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const rejectOnce = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      client.on('ready', () => {
        resolveOnce();
      });
      client.on('error', (error) => {
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: error.message,
        });
        if (!settled) {
          rejectOnce(error);
          return;
        }
        if (!this.manualDisconnect) {
          this.callbacks.onError(error);
          void this.shutdownInternal(true);
        }
      });
      client.on('close', () => {
        if (!settled) {
          rejectOnce(new Error('SSH connection closed before ready'));
          return;
        }
        if (!this.manualDisconnect) {
          void this.shutdownInternal(true);
        }
      });

      client.connect(authConfig);
    });
  }

  private async openCommandChannel(): Promise<void> {
    const sshClient = this.requireSshClient();
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      sshClient.exec('/bin/sh -s', { pty: false }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    this.commandStdoutBuffer = '';
    this.pendingCommand = null;
    this.commandStream = stream;
    stream.on('data', (data: Buffer) => {
      this.commandStdoutBuffer += data.toString();
      this.flushCommandBuffer();
    });
    stream.stderr.on('data', (data: Buffer) => {
      if (this.pendingCommand) {
        this.pendingCommand.stderr += data.toString();
      }
    });
    stream.on('close', () => {
      this.rejectPendingCommand(new Error('SSH command channel closed'));
      this.commandStream = null;
      if (!this.manualDisconnect) {
        void this.shutdownInternal(true);
      }
    });

    const bootstrap = await this.runShell(buildSshBootstrapScript());
    const parsed = parseSshBootstrapOutput(bootstrap.stdout);
    if (!parsed.ok) {
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: parsed.reason,
      });
      throw new Error(`remote tmux unavailable: ${parsed.reason}`);
    }

    this.tmuxBin = parsed.tmuxBin;
    this.remoteHomeDir = parsed.homeDir;

    const version = parseTmuxVersion(parsed.tmuxVersion);
    if (!isControlModeSupported(version)) {
      const message = `remote tmux too old for tmex (control mode requires tmux >= 3.0, found ${parsed.tmuxVersion || 'unknown'})`;
      updateDeviceRuntimeStatus(this.deviceId, {
        lastSeenAt: new Date().toISOString(),
        tmuxAvailable: false,
        lastError: message,
      });
      throw new Error(message);
    }
  }

  private async ensureGhosttyTerminfo(): Promise<boolean> {
    try {
      const result = await this.runShellAllowFailure(buildEnsureGhosttyTerminfoScript(), 15000);
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  private async openControlChannel(onAttachReady: () => void): Promise<ControlChannelHandle> {
    this.controlCommands.dispose('tmux control connection replaced');
    const handle: ControlChannelHandle = { stop: () => {}, write: () => {} };
    const controlCommands = new ControlModeCommandQueue(() => handle.stop());
    this.controlCommands = controlCommands;
    const subscription = createControlModeSubscription(
      this.buildControlModeCallbacks(
        onAttachReady,
        controlCommands,
        (data) => handle.write(data),
        () => this.controlChannel === handle
      )
    );

    this.controlChannel = handle;
    this.controlSubscription = subscription;
    this.controlStartedAt = Date.now();
    this.controlStderrTail = '';

    const reader = await this.openReaderChannel(
      `exec ${quoteShellArg(this.tmuxBin)} -C attach-session -t ${quoteShellArg(this.sessionName)}`,
      {
        onData: (data) => {
          if (this.controlChannel === handle) {
            subscription.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
          }
        },
        onStderr: (data) => {
          if (this.controlChannel === handle) {
            this.controlStderrTail = (this.controlStderrTail + data.toString()).slice(
              -CONTROL_STDERR_TAIL_LIMIT
            );
          }
        },
        onClose: () => {
          this.handleControlChannelClose(handle);
        },
      }
    );
    handle.stop = reader.stop;
    handle.write = reader.write;
    return handle;
  }

  private handleControlChannelClose(handle: ControlChannelHandle): void {
    if (this.controlChannel !== handle) {
      return;
    }
    this.controlChannel = null;
    this.controlSubscription?.dispose();
    this.controlSubscription = null;
    if (!this.connected || this.manualDisconnect) {
      return;
    }
    void this.reconnectControlClient();
  }

  private async reconnectControlClient(): Promise<void> {
    await reconnectControlChannel(CONTROL_RECONNECT_POLICY, {
      host: this as unknown as ControlReconnectHost,
      onGaveUp: (stderr) => {
        const message = stderr || 'tmux control client channel closed repeatedly';
        console.warn(`[ssh] tmux control client gave up on ${this.deviceId}: ${message}`);
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: message,
        });
        void this.shutdownInternal(true);
      },
      onAttempt: (count) => {
        console.warn(
          `[ssh] tmux control client channel closed on ${this.deviceId}, reconnecting (attempt ${count})`
        );
      },
      classifyProbe: (probe) => (probe.exitCode === 0 ? 'alive' : 'gone'),
    });
  }

  private async runTmuxIsolated(
    argv: string[],
    maxOutputBytes: number,
    timeoutMs: number
  ): Promise<CommandResult> {
    const command = `${quoteShellArg(this.tmuxBin)} ${joinShellArgs(argv)}`;
    const result = await this.executeIsolatedShellCommand(command, maxOutputBytes, timeoutMs);
    if (result.exitCode === 0) return result;
    const message = (
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tmux command failed: ${argv.join(' ')}`
    ).trim();
    if (isTargetMissingMessage(message)) throw new TmuxTargetMissingError(message);
    throw new Error(message);
  }

  private executeIsolatedShellCommand(
    command: string,
    maxOutputBytes: number,
    timeoutMs: number
  ): Promise<CommandResult> {
    const sshClient = this.requireSshClient();
    const outputLimit = Math.max(1, Math.floor(maxOutputBytes));
    return new Promise<CommandResult>((resolve, reject) => {
      let settled = false;
      let truncated = false;
      let exitCode = 0;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Uint8Array[] = [];
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
          const next = appendRollingTail(stdout, stdoutBytes, Buffer.from(chunk), outputLimit);
          stdoutBytes = next.total;
          if (next.overflowed) {
            truncated = true;
            try {
              stream?.close();
              stream?.destroy();
            } catch {}
          }
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
            exitCode: truncated ? 0 : exitCode,
            stdout: decodeRollingTail(stdout, stdoutBytes),
            stderr: Buffer.concat(stderr, stderrBytes).toString(),
          });
        });
      });
    });
  }

  private async runShell(command: string, timeoutMs = 10000): Promise<CommandResult> {
    return this.enqueueShellCommand(command, timeoutMs);
  }

  private async runShellAllowFailure(command: string, timeoutMs = 10000): Promise<CommandResult> {
    try {
      return await this.enqueueShellCommand(command, timeoutMs);
    } catch (error) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: errorMessage(error),
      };
    }
  }

  private enqueueShellCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    const next = this.commandQueue
      .catch(() => undefined)
      .then(() => this.executeShellCommand(command, timeoutMs));
    this.commandQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private executeShellCommand(command: string, timeoutMs: number): Promise<CommandResult> {
    const stream = this.commandStream;
    if (!stream) {
      return Promise.reject(new Error('SSH command channel not ready'));
    }

    const commandId = crypto.randomUUID();
    const wrappedCommand = `{ ${command}; } 2>&1\nprintf '\\036TMEX_END %s %d\\036\\n' ${quoteShellArg(
      commandId
    )} $?\n`;

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingCommand || this.pendingCommand.id !== commandId) {
          return;
        }
        this.pendingCommand = null;
        reject(new Error(`remote command timed out: ${command}`));
      }, timeoutMs);

      this.pendingCommand = {
        id: commandId,
        stderr: '',
        resolve,
        reject,
        timer,
      };
      stream.write(wrappedCommand);
    });
  }

  private flushCommandBuffer(): void {
    while (true) {
      const sentinelIndex = this.commandStdoutBuffer.indexOf(COMMAND_SENTINEL);
      if (sentinelIndex < 0) {
        return;
      }

      const sentinelEnd = this.commandStdoutBuffer.indexOf(
        '\x1e',
        sentinelIndex + COMMAND_SENTINEL.length
      );
      if (sentinelEnd < 0) {
        return;
      }

      const payload = this.commandStdoutBuffer
        .slice(sentinelIndex + COMMAND_SENTINEL.length, sentinelEnd)
        .trim();
      const [commandId = '', exitCodeRaw = '1'] = payload.split(/\s+/);
      const stdout = this.commandStdoutBuffer.slice(0, sentinelIndex);
      this.commandStdoutBuffer = this.commandStdoutBuffer
        .slice(sentinelEnd + 1)
        .replace(/^\r?\n/, '');

      const pending = this.pendingCommand;
      if (!pending || pending.id !== commandId) {
        continue;
      }

      this.pendingCommand = null;
      clearTimeout(pending.timer);
      pending.resolve({
        exitCode: Number.parseInt(exitCodeRaw, 10) || 0,
        stdout,
        stderr: pending.stderr,
      });
    }
  }

  private rejectPendingCommand(error: Error): void {
    const pending = this.pendingCommand;
    if (!pending) {
      return;
    }

    this.pendingCommand = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async openReaderChannel(
    command: string,
    options: {
      onData: (data: Buffer) => void;
      onStderr?: (data: Buffer) => void;
      onClose?: () => void;
    }
  ): Promise<{ stop: () => void; write: (data: string) => void }> {
    const sshClient = this.requireSshClient();
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      sshClient.exec('/bin/sh -s', { pty: false }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    stream.on('data', (data: Buffer) => {
      options.onData(data);
    });
    stream.stderr.on('data', (data: Buffer) => {
      if (options.onStderr) {
        options.onStderr(data);
        return;
      }
      if (!this.manualDisconnect) {
        this.callbacks.onError(new Error(data.toString().trim() || 'SSH reader stderr output'));
      }
    });
    stream.on('close', () => {
      options.onClose?.();
    });
    stream.write(`${command}\n`);

    return {
      stop: () => {
        stream.end();
        stream.close();
        stream.destroy();
      },
      write: (data: string) => {
        try {
          stream.write(data);
        } catch {}
      },
    };
  }

  private requireSshClient(): Client {
    if (!this.sshClient) {
      throw new Error('SSH client not connected');
    }
    return this.sshClient;
  }
}
