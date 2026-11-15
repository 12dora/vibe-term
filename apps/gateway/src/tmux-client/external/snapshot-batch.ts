import {
  PANE_SNAPSHOT_FORMAT,
  SESSION_SNAPSHOT_FORMAT,
  WINDOW_SNAPSHOT_FORMAT,
} from '../snapshot-format';
import type { CommandResult } from './types';

export const TMUX_SEQUENCE_SEPARATOR = ';';
export const SNAPSHOT_SECTION_SENTINEL_PREFIX = '__VT_SECTION__';

export interface SnapshotQueryArgv {
  session: string[];
  windows: string[];
  panes: string[];
  combined: string[];
}

export interface SnapshotBatchSections {
  session: string;
  windows: string;
  panes: string;
}

export function snapshotSectionSentinel(section: number): string {
  return `${SNAPSHOT_SECTION_SENTINEL_PREFIX}${section}`;
}

export function buildSnapshotQueryArgv(sessionName: string): SnapshotQueryArgv {
  const session = ['display-message', '-p', '-t', sessionName, SESSION_SNAPSHOT_FORMAT];
  const windows = ['list-windows', '-t', sessionName, '-F', WINDOW_SNAPSHOT_FORMAT];
  const panes = ['list-panes', '-s', '-t', sessionName, '-F', PANE_SNAPSHOT_FORMAT];
  return {
    session,
    windows,
    panes,
    combined: interleaveSnapshotCommands(sessionName, session, windows, panes),
  };
}

export function parseCombinedSnapshotOutput(stdout: string): SnapshotBatchSections | null {
  const lines = stdout.split(/\r?\n/);
  const first = indexOfSentinelLine(lines, 1, 0);
  if (first < 0) {
    return null;
  }
  const second = indexOfSentinelLine(lines, 2, first + 1);
  if (second < 0) {
    return null;
  }
  return {
    session: joinSectionLines(lines, 0, first),
    windows: joinSectionLines(lines, first + 1, second),
    panes: joinSectionLines(lines, second + 1, lines.length),
  };
}

export function snapshotResultsFromSections(
  combined: Pick<CommandResult, 'stderr'>,
  sections: SnapshotBatchSections
): [CommandResult, CommandResult, CommandResult] {
  return [
    { exitCode: 0, stdout: sections.session, stderr: combined.stderr },
    { exitCode: 0, stdout: sections.windows, stderr: '' },
    { exitCode: 0, stdout: sections.panes, stderr: '' },
  ];
}

export function logSnapshotBatchFallback(logPrefix: string, deviceId: string): void {
  console.debug(
    `${logPrefix} combined snapshot query failed; falling back to three calls on ${deviceId}`
  );
}

function snapshotSentinelArgv(sessionName: string, section: number): string[] {
  return ['display-message', '-p', '-t', sessionName, snapshotSectionSentinel(section)];
}

function interleaveSnapshotCommands(
  sessionName: string,
  session: string[],
  windows: string[],
  panes: string[]
): string[] {
  const separator = TMUX_SEQUENCE_SEPARATOR;
  return [
    ...session,
    separator,
    ...snapshotSentinelArgv(sessionName, 1),
    separator,
    ...windows,
    separator,
    ...snapshotSentinelArgv(sessionName, 2),
    separator,
    ...panes,
  ];
}

function indexOfSentinelLine(lines: readonly string[], section: number, from: number): number {
  const sentinel = snapshotSectionSentinel(section);
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i] === sentinel) {
      return i;
    }
  }
  return -1;
}

function joinSectionLines(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).join('\n');
}
