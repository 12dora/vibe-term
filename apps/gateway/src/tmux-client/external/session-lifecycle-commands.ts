import { config } from '../../config';
import { resolveTmuxWindowStyle } from '../window-style';
import { PARKING_WINDOW_NAME } from './constants';
import type { SessionCommandHost } from './session-command-host';
import { runTmux } from './session-command-runner';

export async function ensureSession(host: SessionCommandHost): Promise<{ created: boolean }> {
  const exists = await host.runTmuxAllowFailure(['has-session', '-t', host.sessionName]);
  if (exists.exitCode === 0) {
    return { created: false };
  }

  await runTmux(host, [
    'new-session',
    '-d',
    '-c',
    host.resolveDefaultWorkingDir(),
    '-s',
    host.sessionName,
  ]);
  return { created: true };
}

export async function configureSessionOptions(host: SessionCommandHost): Promise<void> {
  await configureSessionFlags(host);
  await configureTermEnvironment(host);
  await host.runTmuxAllowFailure([
    'set-option',
    '-t',
    host.sessionName,
    'default-path',
    host.resolveDefaultWorkingDir(),
  ]);
  await host.configureWindowStyle();
}

export async function configureWindowStyleDefault(
  host: SessionCommandHost,
  styleValue: string = config.tmuxWindowStyle
): Promise<void> {
  const windowStyle = resolveTmuxWindowStyle(styleValue);
  if (!windowStyle) {
    return;
  }
  await host.runTmuxAllowFailure([
    'set-hook',
    '-t',
    host.sessionName,
    'after-new-window',
    `set-option -w window-style '${windowStyle}'`,
  ]);
  const windows = await host.runTmuxAllowFailure([
    'list-windows',
    '-t',
    host.sessionName,
    '-F',
    '#{window_id}',
  ]);
  if (windows.exitCode !== 0) {
    return;
  }
  for (const line of windows.stdout.split('\n')) {
    const windowId = line.trim();
    if (!windowId) {
      continue;
    }
    await host.runTmuxAllowFailure([
      'set-option',
      '-w',
      '-t',
      windowId,
      'window-style',
      windowStyle,
    ]);
  }
}

export async function createParkingWindow(host: SessionCommandHost): Promise<string | null> {
  const result = await host.runTmuxAllowFailure([
    'new-window',
    '-t',
    host.sessionName,
    '-n',
    PARKING_WINDOW_NAME,
    '-P',
    '-F',
    '#{window_id}',
    host.getParkingCommand(),
  ]);
  if (result.exitCode !== 0) {
    console.warn(
      `${host.logPrefix} failed to create parking window on ${host.deviceId}, attaching without focus shield`
    );
    return null;
  }
  return result.stdout.trim() || null;
}

export async function removeParkingWindow(
  host: SessionCommandHost,
  windowId: string | null
): Promise<void> {
  if (!windowId) {
    return;
  }
  await host.runTmuxAllowFailure(['last-window', '-t', host.sessionName]);
  await host.runTmuxAllowFailure(['kill-window', '-t', windowId]);
}

export async function setWindowStyle(host: SessionCommandHost, style: string): Promise<void> {
  if (!host.connected) {
    return;
  }
  if (!resolveTmuxWindowStyle(config.tmuxWindowStyle)) {
    return;
  }

  await host.configureWindowStyle(style).catch((error) => {
    host.callbacks.onError(error);
  });
}

async function configureSessionFlags(host: SessionCommandHost): Promise<void> {
  const session = host.sessionName;
  await host.runTmuxAllowFailure([
    'set-option',
    '-t',
    session,
    '-s',
    'allow-passthrough',
    config.tmuxAllowPassthrough ? 'on' : 'off',
  ]);
  await host.runTmuxAllowFailure(['set-option', '-t', session, '-g', 'extended-keys', 'on']);
  await host.runTmuxAllowFailure([
    'set-option',
    '-t',
    session,
    '-s',
    'extended-keys-format',
    'csi-u',
  ]);
  // control client 自带 attached+focused 标志，focus-events on 会把 ESC[I 投递给
  // ?1004h 的 pane（如 Claude Code），使其永久判定「用户在场」、通知静默，必须关闭。
  await host.runTmuxAllowFailure(['set-option', '-t', session, '-g', 'focus-events', 'off']);
  await host.runTmuxAllowFailure(['set-option', '-t', session, 'destroy-unattached', 'off']);
}

async function configureTermEnvironment(host: SessionCommandHost): Promise<void> {
  const session = host.sessionName;
  const termProgram = config.tmuxTermProgram.trim();
  if (termProgram && termProgram.toLowerCase() !== 'off') {
    await host.runTmuxAllowFailure(['set-environment', '-t', session, 'TERM_PROGRAM', termProgram]);
    if (termProgram === 'ghostty' && (await host.shouldInstallGhosttyTerminfo())) {
      await host.runTmuxAllowFailure([
        'set-option',
        '-t',
        session,
        'default-terminal',
        'xterm-ghostty',
      ]);
    }
  }

  await host.runTmuxAllowFailure(['set-environment', '-t', session, 'COLORTERM', 'truecolor']);
}
