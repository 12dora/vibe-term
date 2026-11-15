import { describe, expect, test } from 'bun:test';
import { ControlModeCommandQueue } from './control-mode-capture';
import type { MouseReportKind } from './mouse-sequence';
import {
  type MouseTracking,
  PLAIN_SHELL_COMMANDS,
  applyMouseFlags,
  isPlainShellCommand,
  mouseReportAllowed,
  parsePaneMouseFlags,
  queryPaneMouseFlags,
  trackingFromFlags,
  unknownMouseState,
} from './pane-mouse-state';

const known = (tracking: MouseTracking) => ({ ...unknownMouseState(), known: true, tracking });

describe('pane mouse flags', () => {
  test('parses tmux flags with the foreground command', () => {
    expect(parsePaneMouseFlags('0 0 1 1 node\n')).toEqual({
      standard: false,
      button: false,
      all: true,
      sgr: true,
      currentCommand: 'node',
    });
    expect(parsePaneMouseFlags('1 0 0 0')?.currentCommand).toBeNull();
    expect(parsePaneMouseFlags('')).toBeNull();
    expect(parsePaneMouseFlags('x 0 0 0 bash')).toBeNull();
  });

  test('maps flags to tracking, strongest mode first', () => {
    const base = { standard: false, button: false, all: false, sgr: false, currentCommand: 'vim' };
    expect(trackingFromFlags(base)).toBe('none');
    expect(trackingFromFlags({ ...base, standard: true })).toBe('normal');
    expect(trackingFromFlags({ ...base, button: true })).toBe('button');
    expect(trackingFromFlags({ ...base, all: true, standard: true })).toBe('any');
  });

  test('a plain shell in the foreground overrides leftover tmux flags', () => {
    for (const shell of PLAIN_SHELL_COMMANDS) {
      expect(isPlainShellCommand(shell)).toBe(true);
      expect(isPlainShellCommand(`-${shell}`)).toBe(true);
      expect(
        trackingFromFlags({
          standard: true,
          button: true,
          all: true,
          sgr: true,
          currentCommand: shell,
        })
      ).toBe('none');
    }
    expect(isPlainShellCommand('/bin/zsh')).toBe(true);
    for (const command of ['node', 'claude', 'vim', 'bashtop', null, '']) {
      expect(isPlainShellCommand(command)).toBe(false);
    }
  });

  test('applying flags marks the state known and verified', () => {
    const state = unknownMouseState();
    applyMouseFlags(
      state,
      { standard: false, button: true, all: false, sgr: true, currentCommand: 'htop' },
      42
    );
    expect(state).toMatchObject({ known: true, tracking: 'button', sgr: true, verifiedAt: 42 });
  });
});

describe('mouseReportAllowed', () => {
  const matrix: Array<[MouseTracking, Record<MouseReportKind, boolean>]> = [
    ['none', { press: false, release: false, hover: false, drag: false, wheel: false }],
    ['normal', { press: true, release: true, hover: false, drag: false, wheel: true }],
    ['button', { press: true, release: true, hover: false, drag: true, wheel: true }],
    ['any', { press: true, release: true, hover: true, drag: true, wheel: true }],
  ];
  test.each(matrix)('tracking %s', (tracking, expected) => {
    for (const [kind, allowed] of Object.entries(expected)) {
      expect(mouseReportAllowed(known(tracking), kind as MouseReportKind, true)).toBe(allowed);
    }
  });

  test('unknown state holds motion only when a flag query can answer', () => {
    const state = unknownMouseState();
    for (const kind of ['press', 'release', 'wheel'] as const) {
      expect(mouseReportAllowed(state, kind, true)).toBe(true);
    }
    expect(mouseReportAllowed(state, 'hover', true)).toBe(false);
    expect(mouseReportAllowed(state, 'drag', true)).toBe(false);
    expect(mouseReportAllowed(state, 'hover', false)).toBe(true);
  });
});

describe('queryPaneMouseFlags', () => {
  test('issues a non-poisoning display-message and parses the block', async () => {
    const queue = new ControlModeCommandQueue();
    const commands: string[] = [];
    const result = queryPaneMouseFlags(queue, (command) => commands.push(command), '%3');
    expect(commands).toEqual([
      'display-message -p -t %3 "#{mouse_standard_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{pane_current_command}"\n',
    ]);
    queue.handleBlock({ args: '', isError: false, lines: ['0 0 1 1 claude'] });
    expect(await result).toMatchObject({ all: true, currentCommand: 'claude' });
    queue.dispose();
  });

  test('errors, invalid targets and missing writers resolve to null', async () => {
    const queue = new ControlModeCommandQueue();
    expect(await queryPaneMouseFlags(queue, null, '%1')).toBeNull();
    expect(await queryPaneMouseFlags(queue, () => {}, 'bad; kill-server')).toBeNull();
    const failed = queryPaneMouseFlags(queue, () => {}, '%1');
    queue.handleBlock({ args: '', isError: true, lines: ["can't find pane"] });
    expect(await failed).toBeNull();
    queue.dispose();
  });
});
