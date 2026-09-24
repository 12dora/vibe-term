import { describe, expect, test } from 'bun:test';
import { WINDOW_MEMORY_SETTINGS_DEFAULTS } from '@vibeterm/shared';

import {
  argvToScript,
  buildReleasePropertyArgs,
  buildSetPropertyArgs,
  buildStopScopeScript,
  shQuote,
} from './scope-commands';

describe('shQuote', () => {
  test('wraps in single quotes and escapes embedded quotes', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote("a'b")).toBe("'a'\\''b'");
    expect(shQuote('tmux-spawn-x.scope')).toBe("'tmux-spawn-x.scope'");
  });
});

describe('buildSetPropertyArgs', () => {
  test('emits all three properties including infinity for zeros', () => {
    expect(buildSetPropertyArgs('tmux-spawn-a.scope', WINDOW_MEMORY_SETTINGS_DEFAULTS)).toEqual([
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      'tmux-spawn-a.scope',
      'MemoryHigh=8192M',
      'MemoryMax=12288M',
      'MemorySwapMax=4096M',
    ]);
    expect(
      buildSetPropertyArgs('tmux-spawn-a.scope', {
        ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
        memoryHighMb: 0,
        memorySwapMaxMb: 0,
      })
    ).toEqual([
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      'tmux-spawn-a.scope',
      'MemoryHigh=infinity',
      'MemoryMax=12288M',
      'MemorySwapMax=infinity',
    ]);
    expect(
      buildSetPropertyArgs('tmux-spawn-a.scope', {
        ...WINDOW_MEMORY_SETTINGS_DEFAULTS,
        memoryHighMb: 0,
        memoryMaxMb: 0,
        memorySwapMaxMb: 0,
      })
    ).toBeNull();
  });

  test('release args set all three to infinity', () => {
    expect(buildReleasePropertyArgs('tmux-spawn-a.scope')).toEqual([
      'systemctl',
      '--user',
      'set-property',
      '--runtime',
      'tmux-spawn-a.scope',
      'MemoryHigh=infinity',
      'MemoryMax=infinity',
      'MemorySwapMax=infinity',
    ]);
  });
});

describe('buildStopScopeScript', () => {
  test('quotes each scope name and exports the user bus before systemctl', () => {
    expect(buildStopScopeScript([])).toBe('true');
    const script = buildStopScopeScript(['tmux-spawn-a.scope', "tmux-spawn-b's.scope"]);
    expect(script).toContain(
      "systemctl --user stop 'tmux-spawn-a.scope' 'tmux-spawn-b'\\''s.scope'"
    );
    expect(script.indexOf('export XDG_RUNTIME_DIR=')).toBeGreaterThanOrEqual(0);
    expect(script.indexOf('DBUS_SESSION_BUS_ADDRESS')).toBeLessThan(
      script.indexOf('systemctl --user stop')
    );
    expect(argvToScript(['systemctl', '--user', 'stop', 'tmux-spawn-a.scope'])).toBe(
      "'systemctl' '--user' 'stop' 'tmux-spawn-a.scope'"
    );
  });
});
