import type { Device } from '@tmex/shared';
import { Client } from 'ssh2';

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
import { encodeBytesToHexChunks } from './input-encoder';
import { ensureStableServerEpoch } from './server-epoch';
import { buildSshBootstrapScript, parseSshBootstrapOutput } from './ssh-bootstrap';
import { establishSshClientConnection, execSshShellChannel } from './ssh-client-connect';
import { resolveSshConnectConfig } from './ssh-connect-config';
import {
  type ControlChannelHandle,
  openSshReaderChannel,
  reconnectSshControlClient,
} from './ssh-control-channel';
import {
  type SshShellSession,
  attachSshShellStream,
  closeSshShellSession,
  configureSshWindowStyle,
  createSshShellSession,
  runShell,
  runShellAllowFailure,
  runTmuxIsolated,
} from './ssh-shell-session';
import { isControlModeSupported, parseTmuxVersion } from './tmux-version';

interface SshExternalTmuxConnectionDeps {
  getDevice: (deviceId: string) => Device | null;
  decrypt: typeof decryptWithContext;
  createClient: () => Client;
}

export class SshExternalTmuxConnection extends ExternalTmuxConnectionCore {
  protected readonly logPrefix = '[ssh]';
  protected readonly stalledControlLabel = 'channel';

  private readonly deps: SshExternalTmuxConnectionDeps;
  private readonly shell: SshShellSession = createSshShellSession();
  private controlChannel: ControlChannelHandle | null = null;
  private sshClient: Client | null = null;
  private tmuxBin = 'tmux';
  private remoteHomeDir = '.';

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
    this.manualDisconnect = false;
    this.closeNotified = false;
    this.lifecycle.reset();
    this.device = this.deps.getDevice(this.deviceId);
    if (!this.device) {
      throw new Error(`Device not found: ${this.deviceId}`);
    }
    if (this.device.type !== 'ssh') {
      throw new Error(`SshExternalTmuxConnection only supports ssh device: ${this.deviceId}`);
    }

    this.sessionName = this.device.session?.trim() || 'tmex';

    await this.connectSshClient();
    await this.openCommandChannel();
    const { created } = await this.ensureSession();
    const serverEpoch = await ensureStableServerEpoch((argv) => this.runTmuxAllowFailure(argv));
    this.callbacks.onSourceReady?.(serverEpoch);
    await this.configureSessionOptions();
    await this.startControlClient();

    this.connected = true;
    updateDeviceRuntimeStatus(this.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: true,
      lastError: null,
      lastErrorType: null,
    });
    if (created) {
      this.lifecycle.notifySessionCreated();
    }
    await this.requestSnapshotInternal();
  }

  disconnect(): void {
    if (this.manualDisconnect) {
      return;
    }
    this.manualDisconnect = true;
    void this.shutdownInternal(false);
  }

  sendInput(paneId: string, data: string): void {
    this.sendInputBytes(paneId, new TextEncoder().encode(data));
  }

  sendInputBytes(paneId: string, data: Uint8Array): void {
    if (!this.connected) {
      return;
    }

    for (const chunk of encodeBytesToHexChunks(data)) {
      const control = this.controlChannel;
      if (control) {
        void this.controlCommands
          .execute(
            (command) => control.write(command),
            ['send-keys', '-H', '-t', paneId, ...chunk].join(' '),
            { transform: () => undefined, timeoutMs: 30_000 }
          )
          .catch((error) => {
            this.callbacks.onError(error instanceof Error ? error : new Error(String(error)));
          });
      } else {
        void this.runTmux(['send-keys', '-H', '-t', paneId, ...chunk]).catch((error) => {
          this.callbacks.onError(error);
        });
      }
    }
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
    closeSshShellSession(this.shell);
    this.sshClient?.end();
    this.sshClient = null;
  }

  protected async configureWindowStyle(styleValue: string = config.tmuxWindowStyle): Promise<void> {
    await configureSshWindowStyle({
      styleValue,
      deviceId: this.deviceId,
      getSessionName: () => this.sessionName,
      getTmuxBin: () => this.tmuxBin,
      isDev: config.isDev,
      runTmuxAllowFailure: (argv) => this.runTmuxAllowFailure(argv),
      runShellAllowFailure: (command) => this.runShellAllowFailure(command),
    });
  }

  private async connectSshClient(): Promise<void> {
    if (!this.device) {
      throw new Error('SSH device not loaded');
    }
    const authConfig = await resolveSshConnectConfig(this.device, this.deps.decrypt);

    const client = this.deps.createClient();
    this.sshClient = client;

    await establishSshClientConnection(client, authConfig, {
      reportError: (error) => {
        updateDeviceRuntimeStatus(this.deviceId, {
          lastSeenAt: new Date().toISOString(),
          tmuxAvailable: false,
          lastError: error.message,
        });
      },
      isManualDisconnect: () => this.manualDisconnect,
      onUnexpectedError: (error) => {
        this.callbacks.onError(error);
        void this.shutdownInternal(true);
      },
      onUnexpectedClose: () => {
        void this.shutdownInternal(true);
      },
    });
  }

  private async openCommandChannel(): Promise<void> {
    const stream = await execSshShellChannel(this.requireSshClient());
    attachSshShellStream(this.shell, stream, () => {
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

    const reader = await openSshReaderChannel(
      this.requireSshClient(),
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
        onUnboundStderr: (error) => {
          if (!this.manualDisconnect) {
            this.callbacks.onError(error);
          }
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
    return reconnectSshControlClient({
      deviceId: this.deviceId,
      getSessionName: () => this.sessionName,
      isLifecycleActive: () => this.connected && !this.manualDisconnect,
      getControlStartedAt: () => this.controlStartedAt,
      getControlRestartCount: () => this.controlRestartCount,
      setControlRestartCount: (count) => {
        this.controlRestartCount = count;
      },
      getControlStderrTail: () => this.controlStderrTail,
      getActivePaneId: () => this.activePaneId,
      runTmuxAllowFailure: (argv) => this.runTmuxAllowFailure(argv),
      startControlClient: () => this.startControlClient(),
      requestSnapshot: () => this.requestSnapshot(),
      capturePaneHistory: (paneId) => this.capturePaneHistory(paneId),
      shutdownInternal: (notifyClose) => this.shutdownInternal(notifyClose),
      notifySessionClosed: (message) => this.lifecycle.notifySessionClosed(message),
    });
  }

  private async runTmuxIsolated(
    argv: string[],
    maxOutputBytes: number,
    timeoutMs: number
  ): Promise<CommandResult> {
    return runTmuxIsolated(this.requireSshClient(), this.tmuxBin, argv, maxOutputBytes, timeoutMs);
  }

  private async runShell(command: string, timeoutMs = 10000): Promise<CommandResult> {
    return runShell(this.shell, command, timeoutMs);
  }

  private async runShellAllowFailure(command: string, timeoutMs = 10000): Promise<CommandResult> {
    return runShellAllowFailure(this.shell, command, timeoutMs);
  }

  private requireSshClient(): Client {
    if (!this.sshClient) {
      throw new Error('SSH client not connected');
    }
    return this.sshClient;
  }
}
