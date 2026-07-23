import { describe, expect, test } from 'bun:test';
import { applyManagedTmuxNamespace, parseManagedGatewayArgs } from './managed-args';

describe('managed Gateway arguments', () => {
  test('defaults to the tmux default server and clears inherited namespace state', () => {
    const parsed = parseManagedGatewayArgs([]);
    const env: Record<string, string | undefined> = {
      TMEX_TMUX_SOCKET: 'inherited',
    };

    applyManagedTmuxNamespace(env, parsed.tmuxNamespace);

    expect(parsed).toEqual({ version: false, tmuxNamespace: undefined });
    expect(env.TMEX_TMUX_SOCKET).toBeUndefined();
    expect(Object.hasOwn(env, 'TMEX_TMUX_SOCKET')).toBe(false);
  });

  test('accepts one explicit safe namespace', () => {
    const parsed = parseManagedGatewayArgs(['--tmux-namespace', 'vibex-dev']);
    const env: Record<string, string | undefined> = {};

    applyManagedTmuxNamespace(env, parsed.tmuxNamespace);

    expect(parsed).toEqual({ version: false, tmuxNamespace: 'vibex-dev' });
    expect(env.TMEX_TMUX_SOCKET).toBe('vibex-dev');
  });

  test('rejects missing, duplicate, default, unsafe, and unknown values', () => {
    expect(() => parseManagedGatewayArgs(['--tmux-namespace'])).toThrow('requires a value');
    expect(() =>
      parseManagedGatewayArgs(['--tmux-namespace', 'first', '--tmux-namespace', 'second'])
    ).toThrow('only be specified once');
    expect(() => parseManagedGatewayArgs(['--tmux-namespace', 'default'])).toThrow('non-default');
    expect(() => parseManagedGatewayArgs(['--tmux-namespace', '../unsafe'])).toThrow('non-default');
    expect(() => parseManagedGatewayArgs(['--tmux-namespace=vibex-dev'])).toThrow('unknown');
    expect(() => parseManagedGatewayArgs(['--unknown'])).toThrow('unknown');
  });

  test('keeps version as an exclusive immediate mode', () => {
    expect(parseManagedGatewayArgs(['--version'])).toEqual({
      version: true,
      tmuxNamespace: undefined,
    });
    expect(() => parseManagedGatewayArgs(['--version', '--tmux-namespace', 'vibex-dev'])).toThrow(
      'cannot be combined'
    );
  });
});
