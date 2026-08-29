import { SNAPSHOT_FIELD_SEPARATOR } from '../snapshot-format';

export function buildCreateWindowArgv(sessionName: string, cwd: string, name?: string): string[] {
  const argv = ['new-window', '-t', sessionName, '-c', cwd];
  if (name) {
    argv.push('-n', name);
  }
  return argv;
}

export function buildMovePaneArgv(
  srcPaneId: string,
  dstPaneId: string,
  position: 'left' | 'right' | 'top' | 'bottom'
): string[] {
  const argv = ['move-pane'];
  argv.push(position === 'left' || position === 'right' ? '-h' : '-v');
  if (position === 'left' || position === 'top') {
    argv.push('-b');
  }
  argv.push('-s', srcPaneId, '-t', dstPaneId);
  return argv;
}

export function buildSplitPaneArgv(paneId: string, direction: 'h' | 'v', cwd: string): string[] {
  return [
    'split-window',
    direction === 'h' ? '-h' : '-v',
    '-t',
    paneId,
    '-c',
    cwd,
    '-P',
    '-F',
    `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
  ];
}

export function buildBreakPaneArgv(paneId: string, sessionName: string): string[] {
  return [
    'break-pane',
    '-s',
    paneId,
    '-t',
    `${sessionName}:`,
    '-P',
    '-F',
    `#{window_id}${SNAPSHOT_FIELD_SEPARATOR}#{pane_id}`,
  ];
}

export function buildResizePaneByIdArgv(
  paneId: string,
  size: { cols?: number; rows?: number }
): string[] | null {
  const argv = ['resize-pane', '-t', paneId];
  if (size.cols !== undefined) {
    argv.push('-x', String(Math.max(2, Math.floor(size.cols))));
  }
  if (size.rows !== undefined) {
    argv.push('-y', String(Math.max(2, Math.floor(size.rows))));
  }
  if (argv.length === 3) {
    return null;
  }
  return argv;
}
