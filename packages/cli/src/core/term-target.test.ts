import { describe, expect, test } from 'bun:test';
import type { TmuxSession } from '@vibeterm/shared';
import { NotFoundError, UsageError } from './errors';
import { parseTarget } from './resolve';
import { locatePane, locateWindow } from './term-target';
import { fakeSession } from './term-test-fakes';

const session = fakeSession();

function target(raw: string) {
  return parseTarget(raw);
}

describe('locateWindow', () => {
  test('no location means the active window', () => {
    expect(locateWindow(session, target('laptop')).id).toBe('@0');
  });

  test('index, @id and name all resolve', () => {
    expect(locateWindow(session, target('laptop:1')).id).toBe('@1');
    expect(locateWindow(session, target('laptop:@1')).id).toBe('@1');
    expect(locateWindow(session, target('laptop:build')).id).toBe('@1');
  });

  test('a pane reference resolves to its window', () => {
    expect(locateWindow(session, target('laptop:%2')).id).toBe('@1');
  });

  test('an unknown window is a not-found error', () => {
    expect(() => locateWindow(session, target('laptop:nope'))).toThrow(NotFoundError);
  });
});

describe('locatePane', () => {
  test('no location means the active pane of the active window', () => {
    expect(locatePane(session, target('laptop')).pane.id).toBe('%0');
  });

  test('a window reference lands on that window active pane', () => {
    const located = locatePane(session, target('laptop:build'));
    expect(located.window.id).toBe('@1');
    expect(located.pane.id).toBe('%1');
  });

  test('window.pane addresses a pane by index inside that window', () => {
    expect(locatePane(session, target('laptop:1.1')).pane.id).toBe('%2');
    expect(locatePane(session, target('laptop:build.0')).pane.id).toBe('%1');
  });

  test('%id wins over everything else', () => {
    expect(locatePane(session, target('laptop:%2')).pane.id).toBe('%2');
  });

  test('a window name containing a dot still resolves', () => {
    const dotted: TmuxSession = {
      ...session,
      windows: [{ ...session.windows[0], name: 'api.v2' }],
    };
    expect(locatePane(dotted, target('laptop:api.v2')).window.name).toBe('api.v2');
  });

  test('an unknown pane is a not-found error', () => {
    expect(() => locatePane(session, target('laptop:1.9'))).toThrow(NotFoundError);
  });

  test('an ambiguous window name is a usage error', () => {
    const twins: TmuxSession = {
      ...session,
      windows: session.windows.map((window) => ({ ...window, name: 'same' })),
    };
    expect(() => locateWindow(twins, target('laptop:same'))).toThrow(UsageError);
  });
});
