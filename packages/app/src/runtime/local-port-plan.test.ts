import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PEER_PORT,
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TURN_PORT,
  formatPortList,
} from '../../../shared/src/net';
import {
  formatPortPlanForEnv,
  isGatewayExposed,
  parsePublicHttpsPort,
  portPlanFromEnv,
  portPlanLiveFromEnv,
  portRoleFromEnv,
} from './local-port-plan';

describe('parsePublicHttpsPort', () => {
  test('https without a port is 443', () => {
    expect(parsePublicHttpsPort('https://hub.example.com')).toBe(DEFAULT_PUBLIC_HTTPS_PORT);
    expect(parsePublicHttpsPort('https://hub.example.com/')).toBe(443);
  });

  test('explicit port wins, including non-443', () => {
    expect(parsePublicHttpsPort('https://hub.example.com:13443')).toBe(13443);
    expect(parsePublicHttpsPort('https://relay.example.com:443')).toBe(443);
  });

  test('empty or invalid is null', () => {
    expect(parsePublicHttpsPort(undefined)).toBeNull();
    expect(parsePublicHttpsPort('')).toBeNull();
    expect(parsePublicHttpsPort('   ')).toBeNull();
    expect(parsePublicHttpsPort('not a url')).toBeNull();
  });
});

describe('isGatewayExposed', () => {
  test('loopback is not exposed; wildcard and public hosts are', () => {
    expect(isGatewayExposed(undefined)).toBe(false);
    expect(isGatewayExposed('127.0.0.1')).toBe(false);
    expect(isGatewayExposed('localhost')).toBe(false);
    expect(isGatewayExposed('0.0.0.0')).toBe(true);
    expect(isGatewayExposed('::')).toBe(true);
    expect(isGatewayExposed('203.0.113.9')).toBe(true);
  });
});

describe('portPlanFromEnv', () => {
  test('node uses live peer/rtc and omits gateway when bind is loopback', () => {
    const specs = portPlanFromEnv({
      VIBETERM_ROLES: 'node',
      VIBETERM_BIND_HOST: '127.0.0.1',
      GATEWAY_PORT: '9883',
      VIBETERM_PEER_PORT: '39002',
      VIBETERM_RTC_PORT_RANGE: '41000-41099',
    });
    expect(formatPortList(specs)).toBe('39002/tcp, 41000-41099/udp');
  });

  test('hub,node reads public https from the hub URL', () => {
    const specs = portPlanFromEnv({
      VIBETERM_ROLES: 'hub,node',
      VIBETERM_HUB_PUBLIC_URL: 'https://hub.example.com:8443',
      VIBETERM_PEER_PORT: String(DEFAULT_PEER_PORT),
    });
    expect(specs[0]).toMatchObject({ purpose: 'public-https', port: 8443 });
    expect(formatPortList(specs)).toBe('8443/tcp, 39001/tcp, 40000-40099/udp');
  });

  test('relay reads TURN live values and https from the relay URL', () => {
    const live = portPlanLiveFromEnv({
      VIBETERM_ROLES: 'relay',
      VIBETERM_RELAY_PUBLIC_URL: 'https://relay.example.com',
      VIBETERM_TURN_PORT: '3479',
      VIBETERM_TURN_RELAY_PORT_RANGE: '50000-50099',
    });
    expect(live.publicHttpsPort).toBe(443);
    expect(live.turnPort).toBe(3479);
    expect(
      formatPortPlanForEnv({
        VIBETERM_ROLES: 'relay',
        VIBETERM_RELAY_PUBLIC_URL: 'https://relay.example.com',
        VIBETERM_TURN_PORT: '3479',
        VIBETERM_TURN_RELAY_PORT_RANGE: '50000-50099',
      })
    ).toBe('443/tcp, 3479/udp, 50000-50099/udp');
  });

  test('gateway appears only when bind host is not loopback', () => {
    const hidden = portPlanFromEnv({
      VIBETERM_ROLES: 'node',
      VIBETERM_BIND_HOST: '127.0.0.1',
      GATEWAY_PORT: '19663',
    });
    expect(hidden.some((spec) => spec.purpose === 'gateway-http')).toBe(false);
    const exposed = portPlanFromEnv({
      VIBETERM_ROLES: 'node',
      VIBETERM_BIND_HOST: '0.0.0.0',
      GATEWAY_PORT: '19663',
    });
    expect(exposed.at(-1)).toMatchObject({ purpose: 'gateway-http', port: 19663 });
  });

  test('missing role is standalone; missing rtc uses the default range in the spec', () => {
    expect(portRoleFromEnv({})).toBe('standalone');
    const rtc = portPlanFromEnv({}).find((spec) => spec.purpose === 'rtc-ice');
    expect(rtc?.range).toEqual({ ...DEFAULT_RTC_PORT_RANGE });
    expect(portPlanLiveFromEnv({}).turnPort).toBe(DEFAULT_TURN_PORT);
    expect(portPlanLiveFromEnv({ VIBETERM_TURN_PORT: 'off' }).turnPort).toBe(0);
  });

  test('blank rtc on relay,node uses the relay-host ICE slice', () => {
    const live = portPlanLiveFromEnv({ VIBETERM_ROLES: 'relay,node' });
    expect(live.rtcRange).toEqual({ begin: 40050, end: 40099 });
    expect(formatPortPlanForEnv({ VIBETERM_ROLES: 'relay,node' })).toBe(
      '443/tcp, 39001/tcp, 40050-40099/udp, 40000/udp, 40001-40049/udp'
    );
  });

  test('invalid or empty ports fall back to defaults', () => {
    const live = portPlanLiveFromEnv({
      GATEWAY_PORT: 'not-a-port',
      VIBETERM_PEER_PORT: '',
      VIBETERM_TURN_PORT: '65536',
    });
    expect(live.gatewayPort).toBe(DEFAULT_GATEWAY_PORT);
    expect(live.peerPort).toBe(DEFAULT_PEER_PORT);
    expect(live.turnPort).toBe(DEFAULT_TURN_PORT);
  });
});
