import { describe, expect, test } from 'bun:test';
import { UsageError } from './errors';
import { formatTarget, parsePeerTarget, parseTarget } from './resolve';

describe('parseTarget', () => {
  test('device only', () => {
    expect(parseTarget('laptop')).toEqual({
      node: null,
      device: 'laptop',
      location: null,
      window: null,
      pane: null,
    });
  });

  test('node and device', () => {
    const target = parseTarget('office/laptop');
    expect(target.node).toBe('office');
    expect(target.device).toBe('laptop');
    expect(target.location).toBeNull();
  });

  test('window by index', () => {
    const target = parseTarget('laptop:2');
    expect(target.window).toEqual({ raw: '2', index: 2 });
    expect(target.pane).toBeNull();
    expect(target.location).toBe('2');
  });

  test('window and pane by index', () => {
    const target = parseTarget('node1/laptop:2.1');
    expect(target.node).toBe('node1');
    expect(target.window).toEqual({ raw: '2', index: 2 });
    expect(target.pane).toEqual({ raw: '1', index: 1 });
  });

  test('window and pane by name', () => {
    const target = parseTarget('laptop:build.left');
    expect(target.window).toEqual({ raw: 'build', index: null });
    expect(target.pane).toEqual({ raw: 'left', index: null });
  });

  test('keeps the raw location so a dotted window name can be retried whole', () => {
    const target = parseTarget('laptop:my.window.0');
    expect(target.location).toBe('my.window.0');
    expect(target.window?.raw).toBe('my.window');
    expect(target.pane?.raw).toBe('0');
  });

  test('node ids survive as-is', () => {
    const id = 'a'.repeat(32);
    expect(parseTarget(`${id}/dev:1`).node).toBe(id);
  });

  test('trims surrounding whitespace', () => {
    expect(parseTarget('  laptop:1  ').device).toBe('laptop');
  });

  test.each([
    ['', 'empty'],
    ['/dev', 'empty node'],
    ['node/', 'empty device'],
    ['dev:', 'empty window'],
    ['dev:.1', 'empty window part'],
    ['dev:1.', 'empty pane'],
  ])('rejects %p (%s)', (input) => {
    expect(() => parseTarget(input)).toThrow(UsageError);
  });

  test('formatTarget round-trips', () => {
    for (const input of ['laptop', 'office/laptop', 'laptop:2', 'office/laptop:2.1']) {
      expect(formatTarget(parseTarget(input))).toBe(input);
    }
  });
});

describe('parsePeerTarget', () => {
  const source = parseTarget('office/laptop:build.0');

  test('binds a pane-id shorthand to the source device', () => {
    expect(parsePeerTarget('%2', source)).toEqual(parseTarget('office/laptop:%2'));
  });

  test('binds a window.pane shorthand', () => {
    expect(parsePeerTarget('build.1', source)).toEqual(parseTarget('office/laptop:build.1'));
  });

  test('parses a full target as-is', () => {
    expect(parsePeerTarget('office/laptop:%2', source)).toEqual(parseTarget('office/laptop:%2'));
  });

  test('rejects an empty destination', () => {
    expect(() => parsePeerTarget('  ', source)).toThrow(UsageError);
  });
});
