import { TmuxTargetMissingError, isTargetMissingMessage } from '../target-missing';
import { isTmuxServerGoneMessage } from './helpers';
import type { SessionCommandHost } from './session-command-host';
import type { CommandResult } from './types';

export async function runTmux(
  host: SessionCommandHost,
  argv: string[],
  allowTargetMissing: boolean | 'silent' = false,
  timeoutMs = 10_000
): Promise<CommandResult> {
  const result = await host.runTmuxAllowFailure(argv, timeoutMs);
  if (result.exitCode === 0) {
    return result;
  }

  const message = (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `tmux command failed: ${argv.join(' ')}`
  ).trim();
  if (allowTargetMissing && isTargetMissingMessage(message)) {
    if (allowTargetMissing === 'silent') {
      throw new TmuxTargetMissingError(message);
    }
    recoverFromTargetMissingError(host, message);
    return result;
  }

  console.warn(
    `${host.logPrefix} tmux command failed deviceId=${host.deviceId} sessionName=${host.sessionName} argv=${argv.join(' ')} exitCode=${result.exitCode}: ${message}`
  );
  host.reportTmuxCommandFailure(message);
  if (host.connected && !host.manualDisconnect && isTmuxServerGoneMessage(message)) {
    console.warn(`${host.logPrefix} tmux server gone on ${host.deviceId}: ${message}`);
    host.onTmuxServerGone(message);
    host.notifySessionClosed(message);
    void host.shutdownInternal(true);
  }
  throw new Error(message);
}

export function recoverFromTargetMissingError(host: SessionCommandHost, message: string): void {
  const normalized = message.toLowerCase();
  if (normalized.includes('window')) {
    host.activeWindowId = null;
  }
  if (normalized.includes('pane')) {
    host.activePaneId = null;
  }
  host.requestSnapshot();
}
