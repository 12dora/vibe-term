import { describe, expect, test } from 'bun:test';
import { createByteOutputBuffer } from './run-command-buffer';
import {
  applyDisablePaging,
  attachRunCommandTap,
  buildRunCommandPayload,
  isMatchingExitMarker,
} from './run-command-spawn';

describe('buildRunCommandPayload', () => {
  test('非 posix 只发送命令加回车', () => {
    expect(
      buildRunCommandPayload({ command: 'show run', usePosix: false, shell: 'bash', nonce: 'n1' })
    ).toBe('show run\r');
  });

  test('posix 注入 OSC133 D 标记与 nonce', () => {
    const payload = buildRunCommandPayload({
      command: 'ls -la',
      usePosix: true,
      shell: 'bash',
      nonce: 'abc',
    });
    expect(payload.startsWith('ls -la; ')).toBe(true);
    expect(payload).toContain('133;D');
    expect(payload).toContain('tmex=abc');
    expect(payload).toContain('$?');
    expect(payload.endsWith('\r')).toBe(true);
  });

  test('fish 使用 $status，powershell posix 仍回退 $?', () => {
    expect(
      buildRunCommandPayload({ command: 'echo', usePosix: true, shell: 'fish', nonce: 'n' })
    ).toContain('"$status"');
    expect(
      buildRunCommandPayload({ command: 'echo', usePosix: true, shell: 'powershell', nonce: 'n' })
    ).toContain('"$?"');
  });
});

describe('isMatchingExitMarker', () => {
  test('只接受 kind=D', () => {
    expect(isMatchingExitMarker({ kind: 'A', exitCode: 0, params: ['tmex=n'] }, 'n')).toBe(false);
  });

  test('nonce 为空时任意 D 都匹配', () => {
    expect(isMatchingExitMarker({ kind: 'D', exitCode: 0, params: ['0'] }, '')).toBe(true);
  });

  test('nonce 必须出现在 params 里', () => {
    expect(isMatchingExitMarker({ kind: 'D', exitCode: 0, params: ['0', 'tmex=abc'] }, 'abc')).toBe(
      true
    );
    expect(
      isMatchingExitMarker({ kind: 'D', exitCode: 99, params: ['99', 'tmex=OTHER'] }, 'abc')
    ).toBe(false);
  });
});

describe('attachRunCommandTap', () => {
  test('按当前 nonce 记录匹配的 D 标记并累积字节', () => {
    let onBytes: ((d: Uint8Array) => void) | undefined;
    let onMarker:
      | ((m: { kind: 'A' | 'B' | 'C' | 'D'; exitCode: number | null; params: string[] }) => void)
      | undefined;
    let nonce = 'n0';
    const buffer = createByteOutputBuffer();
    const tap = attachRunCommandTap(
      {
        isAlternateScreen: () => false,
        render: () => '',
        tap: (handlers) => {
          onBytes = handlers.onBytes;
          onMarker = handlers.onMarker;
          return () => {
            onBytes = undefined;
            onMarker = undefined;
          };
        },
      },
      buffer,
      () => nonce
    );

    onBytes?.(new TextEncoder().encode('hi'));
    onMarker?.({ kind: 'D', exitCode: 1, params: ['tmex=old'] });
    expect(tap.getReceivedMarker()).toBeNull();
    nonce = 'n1';
    onMarker?.({ kind: 'D', exitCode: 0, params: ['tmex=n1'] });
    expect(tap.getReceivedMarker()?.exitCode).toBe(0);
    expect(buffer.decode()).toBe('hi');
    tap.untap();
    onBytes?.(new TextEncoder().encode('x'));
    expect(buffer.decode()).toBe('hi');
  });
});

describe('applyDisablePaging', () => {
  test('非 cli 或未给 paging 命令时不发送', async () => {
    const sent: string[] = [];
    await applyDisablePaging({
      mode: 'posix',
      disablePagingCommand: 'terminal length 0',
      sendInput: (data) => sent.push(data),
      sleepMs: async () => {},
      resetBuffer: () => {
        throw new Error('should not reset');
      },
    });
    await applyDisablePaging({
      mode: 'cli',
      disablePagingCommand: undefined,
      sendInput: (data) => sent.push(data),
      sleepMs: async () => {},
      resetBuffer: () => {
        throw new Error('should not reset');
      },
    });
    expect(sent).toEqual([]);
  });

  test('cli + paging 命令：发送、等待、reset buffer', async () => {
    const sent: string[] = [];
    const slept: number[] = [];
    let reset = 0;
    await applyDisablePaging({
      mode: 'cli',
      disablePagingCommand: 'terminal length 0',
      sendInput: (data) => sent.push(data),
      sleepMs: async (ms) => {
        slept.push(ms);
      },
      resetBuffer: () => {
        reset += 1;
      },
    });
    expect(sent).toEqual(['terminal length 0\r']);
    expect(slept).toEqual([200]);
    expect(reset).toBe(1);
  });
});
