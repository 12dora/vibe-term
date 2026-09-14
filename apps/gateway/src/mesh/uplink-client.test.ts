import { describe, expect, test } from 'bun:test';
import {
  UPLINK_CONNECT_LOG_INTERVAL_MS,
  UPLINK_CONNECT_TIMEOUT_MS,
  classifyUplinkConnectError,
  uplinkWebSocketTls,
} from './uplink-constants';

describe('uplinkWebSocketTls', () => {
  test('emits tls.ca only when a CA PEM is present', () => {
    expect(uplinkWebSocketTls(null)).toBeUndefined();
    expect(uplinkWebSocketTls([])).toBeUndefined();
    expect(uplinkWebSocketTls(['-----BEGIN CERTIFICATE-----'])).toEqual({
      tls: { ca: ['-----BEGIN CERTIFICATE-----'] },
    });
  });
});

describe('classifyUplinkConnectError', () => {
  test('maps common causes to stable reason codes', () => {
    expect(UPLINK_CONNECT_TIMEOUT_MS).toBe(20_000);
    expect(UPLINK_CONNECT_LOG_INTERVAL_MS).toBe(30_000);
    expect(
      classifyUplinkConnectError(
        Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })
      )
    ).toBe('dns');
    expect(
      classifyUplinkConnectError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      )
    ).toBe('refused');
    expect(classifyUplinkConnectError(new Error('connect-timeout'))).toBe('timeout');
    expect(classifyUplinkConnectError(new Error('auth-timeout'))).toBe('timeout');
    expect(classifyUplinkConnectError(new Error('unable to verify the first certificate'))).toBe(
      'tls'
    );
    expect(
      classifyUplinkConnectError(
        Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
      )
    ).toBe('tls');
    expect(classifyUplinkConnectError(new Error('ws-closed 4401 login required'))).toBe(
      'http_4401'
    );
    expect(classifyUplinkConnectError(new Error('HTTP 403 upgrade rejected'))).toBe('http_403');
    expect(classifyUplinkConnectError(new Error('unauthorized'))).toBe('auth_rejected');
    expect(classifyUplinkConnectError(new Error('unknown-cert'))).toBe('auth_rejected');
    expect(classifyUplinkConnectError(new Error('protocol_error'))).toBe('protocol');
    expect(
      classifyUplinkConnectError(new Error('https://hub.example.com/hub/uplink?token=supersecret'))
    ).toBe('unknown');
  });
});
