import { describe, expect, test } from 'bun:test';
import { classifySshError, sanitizeTmuxErrorMessage } from './error-classify';

describe('classifySshError', () => {
  test('classifies ssh config ref not supported', () => {
    const result = classifySshError(
      new Error('ssh_config_ref_not_supported: 当前版本暂不支持 SSH Config 引用')
    );
    expect(result.type).toBe('ssh_config_ref_not_supported');
    expect(result.messageKey).toBe('sshError.configRefNotSupported');
  });

  test('classifies missing SSH_AUTH_SOCK', () => {
    const result = classifySshError(new Error('SSH_AUTH_SOCK 未设置，无法使用 SSH Agent 认证'));
    expect(result.type).toBe('agent_unavailable');
    expect(result.messageKey).toBe('sshError.agentUnavailable');
  });

  test('classifies connection refused', () => {
    const result = classifySshError(new Error('connect ECONNREFUSED 127.0.0.1:22'));
    expect(result.type).toBe('connection_refused');
    expect(result.messageKey).toBe('sshError.connectionRefused');
  });

  test('classifies tmux unavailable', () => {
    const result = classifySshError(new Error('tmux: command not found'));
    expect(result.type).toBe('tmux_unavailable');
    expect(result.messageKey).toBe('sshError.tmuxUnavailable');
  });

  test('classifies unknown error with params', () => {
    const result = classifySshError(new Error('some unknown error'));
    expect(result.type).toBe('unknown');
    expect(result.messageKey).toBe('sshError.unknown');
    expect(result.messageParams).toEqual({ message: 'some unknown error' });
  });

  test('classifies tmux control timeouts as tmux_busy not connectionTimeout', () => {
    const timedOut = classifySshError(
      new Error('tmux control command timed out: send-keys -H -t %1 1b 5b 3c 33')
    );
    expect(timedOut.type).toBe('tmux_busy');
    expect(timedOut.messageKey).toBe('sshError.tmux_busy');

    const closed = classifySshError(new Error('tmux control command queue is closed'));
    expect(closed.type).toBe('tmux_busy');

    const heartbeat = classifySshError(
      new Error('tmux control client heartbeat timeout on device-1, killing stalled process')
    );
    expect(heartbeat.type).toBe('tmux_busy');
    expect(heartbeat.messageKey).not.toBe('sshError.connectionTimeout');

    const slow = classifySshError(new Error('tmux control channel slow'));
    expect(slow.type).toBe('tmux_busy');

    const stalled = classifySshError(new Error('tmux control channel stalled'));
    expect(stalled.type).toBe('tmux_busy');
  });

  test('keeps SSH network timeouts as timeout', () => {
    const result = classifySshError(new Error('connect ETIMEDOUT 203.0.113.10:22'));
    expect(result.type).toBe('timeout');
    expect(result.messageKey).toBe('sshError.connectionTimeout');
  });

  test('keeps tmux control mode not ready as tmux_unavailable', () => {
    const result = classifySshError(new Error('tmux control mode not ready'));
    expect(result.type).toBe('tmux_unavailable');
  });
});

describe('sanitizeTmuxErrorMessage', () => {
  test('strips send-keys argv and hex after -H', () => {
    const raw =
      'tmux control command timed out: send-keys -H -t %1 1b 5b 3c 33 35 3b 32 31 3b 32 4d';
    expect(sanitizeTmuxErrorMessage(raw)).toBe('tmux control command timed out: send-keys');
  });

  test('replaces a bare -H payload with send-keys', () => {
    expect(sanitizeTmuxErrorMessage('control write -H 1b 5b 3c 33')).toBe(
      'control write send-keys'
    );
  });

  test('caps tmux command text at 120 chars', () => {
    const verb = 'tmux control command timed out: display-message ';
    const raw = `${verb}${'x'.repeat(200)}`;
    const sanitized = sanitizeTmuxErrorMessage(raw);
    expect(sanitized.length).toBe(120);
    expect(sanitized.startsWith('tmux control command timed out: display-message')).toBe(true);
  });

  test('does not cap unrelated errors', () => {
    const raw = `permission denied ${'a'.repeat(200)}`;
    expect(sanitizeTmuxErrorMessage(raw)).toBe(raw);
  });
});
