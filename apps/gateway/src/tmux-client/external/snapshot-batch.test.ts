import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@vibeterm/shared';

import { joinShellArgs } from '../command-builder';
import {
  PANE_SNAPSHOT_FORMAT,
  SESSION_SNAPSHOT_FORMAT,
  WINDOW_SNAPSHOT_FORMAT,
} from '../snapshot-format';
import {
  SNAPSHOT_SECTION_SENTINEL_PREFIX,
  TMUX_SEQUENCE_SEPARATOR,
  buildSnapshotQueryArgv,
  parseCombinedSnapshotOutput,
  snapshotResultsFromSections,
  snapshotSectionSentinel,
} from './snapshot-batch';
import {
  parseSnapshotPanes,
  parseSnapshotSession,
  parseSnapshotWindows,
} from './snapshot-projector';

const ctx = {
  logPrefix: '[test]',
  deviceId: 'dev-1',
  warn: () => {},
};

const SESSION_LINE = '$1|vibeterm';
const WINDOW_LINES = [
  '@1|0|1|ba9d,80x24,0,0,1|main window',
  '@2|1|0|ba9d,80x24,0,0,2|',
  '@3|2|0|ba9d,80x24,0,0,3|窗口 🚀 with spaces',
];
const PANE_LINES = [
  '%1|@1|0|1|80|24|0|0|1|1000|title with spaces|node|/home/user/project',
  '%2|@2|0|0|80|24|0|0|0|1000|||',
  '%3|@3|0|0|80|24|0|0|0|1000|标题|zsh|/tmp/中文',
  '%4|@1|1|0|40|24|40|0|1|1000|line1',
  'still title|cmd|/tmp/path with spaces',
];

function formatCombinedSnapshotOutput(session: string, windows: string, panes: string): string {
  const trimEnd = (part: string) => part.replace(/(?:\r?\n)+$/, '');
  return [
    trimEnd(session),
    snapshotSectionSentinel(1),
    trimEnd(windows),
    snapshotSectionSentinel(2),
    trimEnd(panes),
    '',
  ].join('\n');
}

function parseSeparate(sessionStdout: string, windowStdout: string, paneStdout: string) {
  const session = parseSnapshotSession(sessionStdout.split(/\r?\n/), ctx);
  const parsedWindows = parseSnapshotWindows(windowStdout.split(/\r?\n/), ctx);
  const paneUpdate = parseSnapshotPanes(paneStdout.split(/\r?\n/), parsedWindows.windows, ctx);
  return { session, windows: parsedWindows, paneUpdate };
}

function parseFromCombined(stdout: string) {
  const sections = parseCombinedSnapshotOutput(stdout);
  if (!sections) {
    throw new Error('expected combined snapshot sections');
  }
  return parseSeparate(sections.session, sections.windows, sections.panes);
}

function windowSummary(windows: Map<string, TmuxWindow>) {
  return Array.from(windows.values())
    .sort((left, right) => left.index - right.index)
    .map((window) => ({
      id: window.id,
      name: window.name,
      panes: window.panes.map((pane) => ({
        id: pane.id,
        title: pane.title,
        currentCommand: pane.currentCommand,
        currentPath: pane.currentPath,
      })),
    }));
}

describe('buildSnapshotQueryArgv', () => {
  test('sequences the three queries as one argv with `;` as its own element', () => {
    const argv = buildSnapshotQueryArgv('dev session');
    expect(argv.session).toEqual([
      'display-message',
      '-p',
      '-t',
      'dev session',
      SESSION_SNAPSHOT_FORMAT,
    ]);
    expect(argv.windows).toEqual([
      'list-windows',
      '-t',
      'dev session',
      '-F',
      WINDOW_SNAPSHOT_FORMAT,
    ]);
    expect(argv.panes).toEqual([
      'list-panes',
      '-s',
      '-t',
      'dev session',
      '-F',
      PANE_SNAPSHOT_FORMAT,
    ]);
    expect(argv.combined).toEqual([
      ...argv.session,
      TMUX_SEQUENCE_SEPARATOR,
      'display-message',
      '-p',
      '-t',
      'dev session',
      snapshotSectionSentinel(1),
      TMUX_SEQUENCE_SEPARATOR,
      ...argv.windows,
      TMUX_SEQUENCE_SEPARATOR,
      'display-message',
      '-p',
      '-t',
      'dev session',
      snapshotSectionSentinel(2),
      TMUX_SEQUENCE_SEPARATOR,
      ...argv.panes,
    ]);
    expect(argv.combined.filter((token) => token === TMUX_SEQUENCE_SEPARATOR)).toHaveLength(4);
    expect(argv.combined.some((token) => token.includes(';') && token !== ';')).toBe(false);
  });

  test('ssh quoting keeps `;` and sentinels as tmux argv, not shell separators', () => {
    const quoted = joinShellArgs(buildSnapshotQueryArgv(`dev session;'x`).combined);
    expect(quoted).toContain(`'${TMUX_SEQUENCE_SEPARATOR}'`);
    expect(quoted).toContain(`'${snapshotSectionSentinel(1)}'`);
    expect(quoted).toContain(`'${snapshotSectionSentinel(2)}'`);
    expect(quoted).toContain(`'dev session;'\\''x'`);
    expect(quoted).toContain(`'${SNAPSHOT_SECTION_SENTINEL_PREFIX}1'`);
    const outsideQuotes = quoted
      .replaceAll("'\\''", '')
      .split("'")
      .filter((_, index) => index % 2 === 0)
      .join('');
    expect(outsideQuotes).not.toContain(';');
    expect(outsideQuotes).not.toContain(SNAPSHOT_SECTION_SENTINEL_PREFIX);
  });
});

describe('parseCombinedSnapshotOutput', () => {
  test('combined parse equals separate parse on spaces, empty names, unicode, and newlines', () => {
    const sessionStdout = `${SESSION_LINE}\n`;
    const windowStdout = `${WINDOW_LINES.join('\n')}\n`;
    const paneStdout = `${PANE_LINES.join('\n')}\n`;
    const combined = formatCombinedSnapshotOutput(sessionStdout, windowStdout, paneStdout);

    const separate = parseSeparate(sessionStdout, windowStdout, paneStdout);
    const batched = parseFromCombined(combined);

    expect(batched.session).toEqual(separate.session);
    expect(batched.windows.activeWindowId).toBe(separate.windows.activeWindowId);
    expect(windowSummary(batched.windows.windows)).toEqual(windowSummary(separate.windows.windows));
    expect(batched.paneUpdate).toEqual(separate.paneUpdate);
    expect(batched.session).toEqual({ id: '$1', name: 'vibeterm' });
    expect(batched.windows.windows.get('@2')?.name).toBe('');
    expect(batched.windows.windows.get('@3')?.name).toBe('窗口 🚀 with spaces');
    expect(batched.windows.windows.get('@1')?.panes[0]?.title).toBe('title with spaces');
    expect(batched.windows.windows.get('@2')?.panes[0]?.title).toBe('');
    expect(batched.windows.windows.get('@3')?.panes[0]?.currentPath).toBe('/tmp/中文');
  });

  test('keeps empty sections and fields that contain newlines inside their sentinel bounds', () => {
    const combined = [
      '$7|',
      snapshotSectionSentinel(1),
      snapshotSectionSentinel(2),
      '%1|@1|0|1|80|24|0|0|1|1000|line1',
      'line2|zsh|/tmp',
      '',
    ].join('\n');
    const sections = parseCombinedSnapshotOutput(combined);
    expect(sections).toEqual({
      session: '$7|',
      windows: '',
      panes: '%1|@1|0|1|80|24|0|0|1|1000|line1\nline2|zsh|/tmp\n',
    });
    expect(parseSnapshotSession(sections?.session.split(/\r?\n/) ?? [], ctx)).toEqual({
      id: '$7',
      name: '',
    });
  });

  test('returns null when a section sentinel is missing', () => {
    expect(parseCombinedSnapshotOutput(`${SESSION_LINE}\n${WINDOW_LINES[0]}\n`)).toBeNull();
    expect(
      parseCombinedSnapshotOutput(
        `${SESSION_LINE}\n${snapshotSectionSentinel(1)}\n@1|0|1|layout|main\n`
      )
    ).toBeNull();
    expect(
      parseCombinedSnapshotOutput(
        `${SESSION_LINE}\n${snapshotSectionSentinel(2)}\n${snapshotSectionSentinel(1)}\n`
      )
    ).toBeNull();
  });

  test('synthesizes successful per-section results from a combined command', () => {
    const sections = {
      session: SESSION_LINE,
      windows: WINDOW_LINES[0] ?? '',
      panes: PANE_LINES[0] ?? '',
    };
    expect(snapshotResultsFromSections({ stderr: 'note' }, sections)).toEqual([
      { exitCode: 0, stdout: SESSION_LINE, stderr: 'note' },
      { exitCode: 0, stdout: WINDOW_LINES[0] ?? '', stderr: '' },
      { exitCode: 0, stdout: PANE_LINES[0] ?? '', stderr: '' },
    ]);
  });
});
