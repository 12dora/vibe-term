import { truncateUtf8Tail } from '../bytes';
import { PANE_HISTORY_CAPTURE_INFO_FORMAT, parsePaneHistoryCaptureInfo } from './capture-history';
import { type ControlModeCommandQueue, capturedBlockText } from './control-mode-capture';
import type { ControlModeBlock } from './control-mode-parser';
import type { CommandResult } from './external/types';
import type { HistoryRangeRequest, PaneHistoryCaptureInfo } from './pane-history-page';
import { PaneHistoryCursorError } from './pane-history-session';
import { isTmuxPaneId } from './snapshot-format';
import { TmuxTargetMissingError, isTargetMissingMessage } from './target-missing';

function historyCommand(argv: string[]): string {
  if (!isTmuxPaneId(argv[argv.indexOf('-t') + 1] ?? '')) {
    throw new Error('invalid tmux history target');
  }
  return argv.map((arg) => `"${arg.replace(/([\\"$])/g, '\\$1')}"`).join(' ');
}

export function historyRangeArgv(paneId: string, start: number, end: number): string[] {
  if (!isTmuxPaneId(paneId) || !Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error('invalid tmux history range');
  }
  return ['capture-pane', '-t', paneId, '-p', '-e', '-N', '-S', String(start), '-E', String(end)];
}

function historyCaptureText(block: ControlModeBlock, maxOutputBytes: number): string {
  const text = `${capturedBlockText(block)}\n`;
  const bytes = new TextEncoder().encode(text);
  return new TextDecoder().decode(truncateUtf8Tail(bytes, Math.max(1, Math.floor(maxOutputBytes))));
}

export async function runControlHistoryCommand<T>(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  argv: string[],
  transform: (block: ControlModeBlock) => T,
  literal = false
): Promise<T> {
  try {
    return await queue.execute(write, historyCommand(argv), { literal, transform });
  } catch (error) {
    if (error instanceof Error && isTargetMissingMessage(error.message)) {
      throw new TmuxTargetMissingError(error.message);
    }
    throw error;
  }
}

export function queryControlHistory(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  argv: string[]
): Promise<CommandResult> {
  return runControlHistoryCommand(queue, write, argv, (block) => ({
    exitCode: 0,
    stdout: `${capturedBlockText(block)}\n`,
    stderr: '',
  }));
}

export function captureControlHistory(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  argv: string[],
  maxOutputBytes: number
): Promise<string> {
  return runControlHistoryCommand(
    queue,
    write,
    argv,
    (block) => historyCaptureText(block, maxOutputBytes),
    true
  );
}

export async function captureAtBarrier(
  queue: ControlModeCommandQueue,
  write: (command: string) => void,
  paneId: string,
  range: HistoryRangeRequest,
  expectedInfo: PaneHistoryCaptureInfo
): Promise<string> {
  const argv = historyRangeArgv(paneId, range.startCoordinate, range.endCoordinate);
  // 范围依赖前一次元信息；复核与捕获连续写入，不等待回复或占用输入锁。
  const infoPromise = queryControlHistory(queue, write, [
    'display-message',
    '-p',
    '-t',
    paneId,
    PANE_HISTORY_CAPTURE_INFO_FORMAT,
  ]);
  const capturePromise = captureControlHistory(queue, write, argv, range.captureLimit);
  const [result, text] = await Promise.all([infoPromise, capturePromise]);
  const info = parsePaneHistoryCaptureInfo(result.stdout);
  if (info.historySize !== expectedInfo.historySize || info.cols !== expectedInfo.cols) {
    throw new PaneHistoryCursorError('cache_evicted', 'tmux history changed before capture');
  }
  return text;
}

export async function captureSpawnHistory(
  host: { run: (argv: string[], maxOutputBytes: number) => Promise<CommandResult> },
  argv: string[],
  maxOutputBytes: number
): Promise<string> {
  const result = await host.run(argv, maxOutputBytes);
  if (result.exitCode === 0) return result.stdout;
  const message = (
    result.stderr.trim() ||
    result.stdout.trim() ||
    `tmux command failed: ${argv.join(' ')}`
  ).trim();
  if (isTargetMissingMessage(message)) throw new TmuxTargetMissingError(message);
  throw new Error(message);
}
