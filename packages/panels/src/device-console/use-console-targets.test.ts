import { describe, expect, test } from 'bun:test';
import type { TmuxWindow } from '@tmex/shared';
import { consoleWindowPresentationKey, consoleWindowsTopologyKey } from './use-console-targets';

function windows(): TmuxWindow[] {
  return [
    {
      id: '@1',
      name: 'shell',
      index: 0,
      active: true,
      layout: 'layout-1',
      panes: [
        {
          id: '%1',
          windowId: '@1',
          index: 0,
          active: true,
          width: 80,
          height: 24,
          title: 'before',
          currentPath: '/work',
          currentCommand: 'zsh',
        },
      ],
    },
    {
      id: '@2',
      name: 'logs',
      index: 1,
      active: false,
      panes: [
        {
          id: '%2',
          windowId: '@2',
          index: 0,
          active: true,
          width: 100,
          height: 30,
          title: 'tail',
        },
      ],
    },
  ];
}

describe('console snapshot subscription keys', () => {
  test('metadata-only patches keep the topology key stable', () => {
    const before = windows();
    const after = structuredClone(before);
    after[0]!.name = 'renamed';
    after[0]!.customName = 'custom';
    after[0]!.panes[0]!.title = 'after';
    after[0]!.panes[0]!.currentPath = '/tmp';
    after[0]!.panes[0]!.currentCommand = 'bun';

    expect(consoleWindowsTopologyKey(after)).toBe(consoleWindowsTopologyKey(before));
    expect(consoleWindowPresentationKey(after, '@1')).not.toBe(
      consoleWindowPresentationKey(before, '@1')
    );
  });

  test('metadata from another window does not invalidate the selected window key', () => {
    const before = windows();
    const after = structuredClone(before);
    after[1]!.panes[0]!.title = 'busy logs';
    after[1]!.panes[0]!.currentPath = '/var/log';

    expect(consoleWindowPresentationKey(after, '@1')).toBe(
      consoleWindowPresentationKey(before, '@1')
    );
  });

  test('layout, geometry, active state, and pane membership invalidate topology', () => {
    const before = windows();
    const resized = structuredClone(before);
    resized[0]!.panes[0]!.width += 1;
    const relayout = structuredClone(before);
    relayout[0]!.layout = 'layout-2';
    const activated = structuredClone(before);
    activated[0]!.active = false;
    const added = structuredClone(before);
    added[0]!.panes.push({
      id: '%3',
      windowId: '@1',
      index: 1,
      active: false,
      width: 40,
      height: 24,
    });

    const key = consoleWindowsTopologyKey(before);
    expect(consoleWindowsTopologyKey(resized)).not.toBe(key);
    expect(consoleWindowsTopologyKey(relayout)).not.toBe(key);
    expect(consoleWindowsTopologyKey(activated)).not.toBe(key);
    expect(consoleWindowsTopologyKey(added)).not.toBe(key);
  });
});
