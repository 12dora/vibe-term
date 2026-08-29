import type { Client } from 'ssh2';

import { updateDeviceRuntimeStatus } from '../db';
import {
  CONTROL_MAX_RESTARTS,
  CONTROL_RESTART_DELAY_MS,
  CONTROL_STABLE_RESET_MS,
  type CommandResult,
  type ExternalControlHandle,
} from './external-tmux-core';
import { execSshShellChannel } from './ssh-client-connect';

export interface ControlChannelHandle extends ExternalControlHandle {
  stop: () => void;
}

export interface SshControlReconnectContext {
  deviceId: string;
  getSessionName: () => string;
  isLifecycleActive: () => boolean;
  getControlStartedAt: () => number;
  getControlRestartCount: () => number;
  setControlRestartCount: (count: number) => void;
  getControlStderrTail: () => string;
  getActivePaneId: () => string | null;
  runTmuxAllowFailure: (argv: string[]) => Promise<CommandResult>;
  startControlClient: () => Promise<void>;
  requestSnapshot: () => void;
  capturePaneHistory: (paneId: string) => Promise<void>;
  shutdownInternal: (notifyClose: boolean) => Promise<void>;
  notifySessionClosed: (message: string) => void;
}

export async function openSshReaderChannel(
  sshClient: Client,
  command: string,
  options: {
    onData: (data: Buffer) => void;
    onStderr?: (data: Buffer) => void;
    onClose?: () => void;
    onUnboundStderr?: (message: Error) => void;
  }
): Promise<{ stop: () => void; write: (data: string) => void }> {
  const stream = await execSshShellChannel(sshClient);
  stream.on('data', (data: Buffer) => {
    options.onData(data);
  });
  stream.stderr.on('data', (data: Buffer) => {
    if (options.onStderr) {
      options.onStderr(data);
      return;
    }
    options.onUnboundStderr?.(new Error(data.toString().trim() || 'SSH reader stderr output'));
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

export async function reconnectSshControlClient(ctx: SshControlReconnectContext): Promise<void> {
  if (Date.now() - ctx.getControlStartedAt() > CONTROL_STABLE_RESET_MS) {
    ctx.setControlRestartCount(0);
  }
  ctx.setControlRestartCount(ctx.getControlRestartCount() + 1);
  const stderrMessage = ctx.getControlStderrTail().trim();

  if (ctx.getControlRestartCount() > CONTROL_MAX_RESTARTS) {
    const message = stderrMessage || 'tmux control client channel closed repeatedly';
    console.warn(`[ssh] tmux control client gave up on ${ctx.deviceId}: ${message}`);
    updateDeviceRuntimeStatus(ctx.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
    void ctx.shutdownInternal(true);
    return;
  }

  console.warn(
    `[ssh] tmux control client channel closed on ${ctx.deviceId}, reconnecting (attempt ${ctx.getControlRestartCount()})`
  );
  await new Promise((resolve) =>
    setTimeout(resolve, CONTROL_RESTART_DELAY_MS * ctx.getControlRestartCount())
  );
  if (!ctx.isLifecycleActive()) {
    return;
  }

  const probe = await ctx.runTmuxAllowFailure(['has-session', '-t', ctx.getSessionName()]);
  if (probe.exitCode !== 0) {
    const message = probe.stderr.trim() || probe.stdout.trim() || 'tmux session gone';
    console.warn(`[ssh] tmux session gone on ${ctx.deviceId}: ${message}`);
    updateDeviceRuntimeStatus(ctx.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
    ctx.notifySessionClosed(message);
    void ctx.shutdownInternal(true);
    return;
  }
  if (!ctx.isLifecycleActive()) {
    return;
  }

  try {
    await ctx.startControlClient();
  } catch (error) {
    console.warn(`[ssh] control client restart failed on ${ctx.deviceId}:`, error);
    return;
  }
  ctx.requestSnapshot();
  const activePaneId = ctx.getActivePaneId();
  if (activePaneId) {
    void ctx.capturePaneHistory(activePaneId).catch(() => undefined);
  }
}
