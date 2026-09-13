import { describe, expect, test } from 'bun:test';
import { buildSshRemoteCommand } from './remote-command';
import type { ExecRequest } from './types';

function req(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    deviceId: 'd1',
    argv: ['/bin/echo', 'hi'],
    timeoutMs: 1000,
    maxBytes: 8 * 1024 * 1024,
    shell: false,
    ...overrides,
  };
}

describe('buildSshRemoteCommand', () => {
  test('uses exec argv when there is no cwd or env', () => {
    expect(buildSshRemoteCommand(req())).toBe("exec '/bin/echo' 'hi'");
  });

  test('prefixes cd && when cwd is set', () => {
    expect(buildSshRemoteCommand(req({ cwd: "/tmp/a'b" }))).toBe(
      "cd '/tmp/a'\\''b' && exec '/bin/echo' 'hi'"
    );
  });

  test('uses env KEY=val without a builtin exec', () => {
    expect(buildSshRemoteCommand(req({ env: { FOO: 'bar baz' } }))).toBe(
      "env FOO='bar baz' '/bin/echo' 'hi'"
    );
  });

  test('shell:true runs /bin/sh -c, not bash -lc', () => {
    expect(buildSshRemoteCommand(req({ shell: true, argv: ['echo hi && echo lo'] }))).toBe(
      "exec /bin/sh -c 'echo hi && echo lo'"
    );
  });

  test('cwd + env + shell combine as cd && env ... /bin/sh -c', () => {
    expect(
      buildSshRemoteCommand(req({ cwd: '/tmp', env: { A: '1' }, shell: true, argv: ['pwd'] }))
    ).toBe("cd '/tmp' && env A='1' /bin/sh -c 'pwd'");
  });
});
