import { afterEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../lib/args';
import { JoinError } from './hub';
import { joinErrorHttpStatus, resolveJoinTotpCode } from './hub-join-totp';

describe('joinErrorHttpStatus', () => {
  test('maps totp and join failures to 400', () => {
    expect(joinErrorHttpStatus('totp_required')).toBe(400);
    expect(joinErrorHttpStatus('totp_invalid')).toBe(400);
    expect(joinErrorHttpStatus('join_failed')).toBe(400);
    expect(joinErrorHttpStatus('invalid_token')).toBe(400);
  });

  test('maps node conflicts to 409 and unreachable to 502', () => {
    expect(joinErrorHttpStatus('node_revoked')).toBe(409);
    expect(joinErrorHttpStatus('node_exists')).toBe(409);
    expect(joinErrorHttpStatus('hub_unreachable')).toBe(502);
  });
});

describe('resolveJoinTotpCode', () => {
  const prev = process.env.TMEX_TOTP;

  afterEach(() => {
    if (prev === undefined) delete process.env.TMEX_TOTP;
    else process.env.TMEX_TOTP = prev;
  });

  test('prefers --totp over io and env', () => {
    process.env.TMEX_TOTP = '111111';
    const parsed = parseArgs(['hub', 'join', 'https://hub.example', '--totp', '222222']);
    expect(resolveJoinTotpCode(parsed, { totpCode: '333333' })).toBe('222222');
  });

  test('uses HubIo.totpCode then TMEX_TOTP', () => {
    delete process.env.TMEX_TOTP;
    const parsed = parseArgs(['hub', 'join', 'https://hub.example']);
    expect(resolveJoinTotpCode(parsed, { totpCode: '444444' })).toBe('444444');
    process.env.TMEX_TOTP = '555555';
    expect(resolveJoinTotpCode(parsed, {})).toBe('555555');
  });

  test('returns undefined when nothing is provided', () => {
    delete process.env.TMEX_TOTP;
    const parsed = parseArgs(['hub', 'join', 'https://hub.example']);
    expect(resolveJoinTotpCode(parsed, {})).toBeUndefined();
  });
});

describe('JoinError totp codes', () => {
  test('constructs totp_required / totp_invalid', () => {
    expect(new JoinError('totp_required', 'TOTP code is required').code).toBe('totp_required');
    expect(new JoinError('totp_invalid', 'TOTP code is invalid').code).toBe('totp_invalid');
  });
});
