import { encodePaneModes } from '@tmex/shared';

import {
  PANE_HISTORY_CAPTURE_INFO_FORMAT,
  PANE_META_FORMAT,
  PANE_SCREEN_INFO_FORMAT,
  type PaneInfo,
  appendCursorRestore,
  parsePaneHistoryCaptureInfo,
  parsePaneMeta,
  parsePaneScreenInfo,
} from '../capture-history';
import { type AtomicPaneCapture, capturePaneFrameAtControlBarrier } from '../control-mode-capture';
import { isTmuxPaneId } from '../snapshot-format';
import { hasRenderableTerminalContent } from './helpers';
import type { SessionCommandHost } from './session-command-host';
import { runTmux } from './session-command-runner';

export async function requestPaneHistory(host: SessionCommandHost, paneId: string): Promise<void> {
  if (!host.connected) {
    return;
  }
  await capturePaneHistory(host, paneId);
}

export async function capturePaneText(
  host: SessionCommandHost,
  paneId: string,
  opts?: { historyLines?: number }
): Promise<string> {
  if (!host.connected) {
    throw new Error(`tmux connection not available: ${host.deviceId}`);
  }

  const argv = ['capture-pane', '-t', paneId, '-p', '-J'];
  const historyLines = Math.floor(opts?.historyLines ?? 0);
  if (Number.isFinite(historyLines) && historyLines > 0) {
    argv.push('-S', `-${historyLines}`);
  }
  return (await runTmux(host, argv, 'silent', 30_000)).stdout;
}

export async function getPaneInfo(host: SessionCommandHost, paneId: string): Promise<PaneInfo> {
  if (!host.connected) {
    throw new Error(`tmux connection not available: ${host.deviceId}`);
  }
  const { stdout } = await runTmux(
    host,
    ['display-message', '-p', '-t', paneId, PANE_META_FORMAT],
    'silent',
    30_000
  );
  return parsePaneMeta(stdout);
}

export async function getPaneHistoryCaptureInfo(host: SessionCommandHost, paneId: string) {
  if (!host.connected) {
    throw new Error(`tmux connection not available: ${host.deviceId}`);
  }
  const { stdout } = await host.runHistoryQuery([
    'display-message',
    '-p',
    '-t',
    paneId,
    PANE_HISTORY_CAPTURE_INFO_FORMAT,
  ]);
  return parsePaneHistoryCaptureInfo(stdout);
}

export async function capturePaneHistoryRange(
  host: SessionCommandHost,
  paneId: string,
  startLine: number,
  endLine: number,
  maxOutputBytes: number
): Promise<string> {
  if (!host.connected) {
    throw new Error(`tmux connection not available: ${host.deviceId}`);
  }
  if (!isTmuxPaneId(paneId) || !Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw new Error('invalid tmux history range');
  }
  return host.runHistoryCapture(
    [
      'capture-pane',
      '-t',
      paneId,
      '-p',
      '-e',
      '-N',
      '-S',
      String(startLine),
      '-E',
      String(endLine),
    ],
    maxOutputBytes
  );
}

export function capturePaneFrameAtBarrier(
  host: SessionCommandHost,
  paneId: string,
  historyLines: number,
  onBarrier: () => void
): Promise<AtomicPaneCapture> {
  const write = host.getControlWriter();
  if (!host.connected || !write) {
    return Promise.reject(new Error(`tmux control connection not available: ${host.deviceId}`));
  }
  return capturePaneFrameAtControlBarrier(
    host.controlCommands,
    (command) => write(command),
    paneId,
    historyLines,
    onBarrier,
    host.getControlCommandTimeoutMs()
  );
}

export async function fetchPaneHistory(
  host: SessionCommandHost,
  paneId: string
): Promise<{ data: string; alternateScreen: boolean; modes: number } | null> {
  const screenInfo = parsePaneScreenInfo(
    (await runTmux(host, ['display-message', '-p', '-t', paneId, PANE_SCREEN_INFO_FORMAT], true))
      .stdout
  );
  const normal = (
    await runTmux(
      host,
      ['capture-pane', '-t', paneId, '-S', '-', '-E', '-', '-e', '-J', '-N', '-p'],
      true,
      30_000
    )
  ).stdout;
  const alternate = (
    await runTmux(
      host,
      ['capture-pane', '-t', paneId, '-a', '-S', '-', '-E', '-', '-e', '-J', '-N', '-p', '-q'],
      true,
      30_000
    )
  ).stdout;

  const history = screenInfo.alternateScreen
    ? hasRenderableTerminalContent(normal)
      ? normal
      : alternate
    : normal || alternate;

  if (!history) {
    return null;
  }
  return {
    data: appendCursorRestore(history, screenInfo),
    alternateScreen: screenInfo.alternateScreen,
    modes: encodePaneModes(screenInfo.modes),
  };
}

export async function capturePaneHistory(host: SessionCommandHost, paneId: string): Promise<void> {
  const captured = await fetchPaneHistory(host, paneId);
  if (captured) {
    host.callbacks.onTerminalHistory(
      paneId,
      captured.data,
      captured.alternateScreen,
      captured.modes
    );
  }
}
