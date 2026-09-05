import { updateDeviceRuntimeStatus } from '../db';
import {
  CONTROL_MAX_RESTARTS,
  CONTROL_RESTART_DELAY_MS,
  CONTROL_STABLE_RESET_MS,
} from './external/constants';
import type { CommandResult } from './external/types';

export const CONTROL_RECONNECT_POLICY = {
  maxRestarts: CONTROL_MAX_RESTARTS,
  restartDelayMs: CONTROL_RESTART_DELAY_MS,
  stableResetMs: CONTROL_STABLE_RESET_MS,
} as const;

export type ProbeDisposition = 'alive' | 'gone' | 'retry';

export type ControlReconnectHost = {
  controlStartedAt: number;
  controlRestartCount: number;
  controlStderrTail: string;
  connected: boolean;
  manualDisconnect: boolean;
  activePaneId: string | null;
  sessionName: string;
  deviceId: string;
  logPrefix: string;
  runTmuxAllowFailure(argv: string[]): Promise<CommandResult>;
  startControlClient(): Promise<void>;
  requestSnapshot(): void;
  capturePaneHistory(paneId: string): Promise<unknown>;
  lifecycle: { notifySessionClosed(message: string): void };
  shutdownInternal(notifyClose: boolean): Promise<void>;
};

export type ControlReconnectAdapter = {
  host: ControlReconnectHost;
  onGaveUp(stderr: string): void;
  onAttempt(count: number): void;
  classifyProbe(probe: CommandResult): ProbeDisposition;
  now?(): number;
  sleep?(ms: number): Promise<void>;
};

export async function reconnectControlChannel(
  policy: { maxRestarts: number; restartDelayMs: number; stableResetMs: number },
  adapter: ControlReconnectAdapter
): Promise<{ retryDelayMs: number } | undefined> {
  const host = adapter.host;
  const now = adapter.now ?? Date.now;
  const sleep =
    adapter.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const live = () => host.connected && !host.manualDisconnect;
  if (now() - host.controlStartedAt > policy.stableResetMs) host.controlRestartCount = 0;
  host.controlRestartCount += 1;
  const stderrMessage = host.controlStderrTail.trim();
  if (host.controlRestartCount > policy.maxRestarts) {
    adapter.onGaveUp(stderrMessage);
    return;
  }
  adapter.onAttempt(host.controlRestartCount);
  await sleep(policy.restartDelayMs * host.controlRestartCount);
  if (!live()) return;
  const probe = await host.runTmuxAllowFailure(['has-session', '-t', host.sessionName]);
  const disposition = adapter.classifyProbe(probe);
  if (disposition === 'retry') {
    host.controlRestartCount = Math.max(0, host.controlRestartCount - 1);
    return live() ? { retryDelayMs: policy.restartDelayMs * 4 } : undefined;
  }
  if (disposition === 'gone') {
    const message = probe.stderr.trim() || probe.stdout.trim() || 'tmux session gone';
    console.warn(`${host.logPrefix} tmux session gone on ${host.deviceId}: ${message}`);
    updateDeviceRuntimeStatus(host.deviceId, {
      lastSeenAt: new Date().toISOString(),
      tmuxAvailable: false,
      lastError: message,
    });
    host.lifecycle.notifySessionClosed(message);
    void host.shutdownInternal(true);
    return;
  }
  if (!live()) return;
  try {
    await host.startControlClient();
  } catch (error) {
    console.warn(`${host.logPrefix} control client restart failed on ${host.deviceId}:`, error);
    return;
  }
  // 每次重挂都会建/删一次聚焦护盾窗口：留痕才能把 %window-close 与重连对上
  console.info(
    `${host.logPrefix} control client reattached device=${host.deviceId} attempt=${host.controlRestartCount} session=${host.sessionName}`
  );
  host.requestSnapshot();
  if (host.activePaneId) void host.capturePaneHistory(host.activePaneId).catch(() => undefined);
}
