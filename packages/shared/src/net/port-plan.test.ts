import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_PEER_PORT,
  DEFAULT_PUBLIC_HTTPS_PORT,
  DEFAULT_RTC_PORT_RANGE,
  DEFAULT_TLS_PORT,
  DEFAULT_TURN_PORT,
  DEFAULT_TURN_RELAY_PORT_RANGE,
  type PortPlanLive,
  type PortPurpose,
  type PortSpec,
  formatPortList,
  formatPortSpec,
  parsePortRange,
  portPlanForRole,
} from './port-plan';

function live(over: Partial<PortPlanLive> = {}): PortPlanLive {
  return {
    gatewayPort: DEFAULT_GATEWAY_PORT,
    gatewayExposed: false,
    peerPort: DEFAULT_PEER_PORT,
    rtcRange: null,
    turnPort: DEFAULT_TURN_PORT,
    turnRelayRange: { ...DEFAULT_TURN_RELAY_PORT_RANGE },
    publicHttpsPort: null,
    ...over,
  };
}

function purposes(specs: PortSpec[]): PortPurpose[] {
  return specs.map((spec) => spec.purpose);
}

function requiredByPurpose(specs: PortSpec[]): Record<string, boolean> {
  return Object.fromEntries(specs.map((spec) => [spec.purpose, spec.required]));
}

describe('port-plan defaults', () => {
  test('pins the fleet-wide default numbers', () => {
    expect(DEFAULT_GATEWAY_PORT).toBe(9883);
    expect(DEFAULT_PEER_PORT).toBe(39001);
    expect(DEFAULT_RTC_PORT_RANGE).toEqual({ begin: 40000, end: 40099 });
    expect(DEFAULT_TURN_PORT).toBe(3478);
    expect(DEFAULT_TURN_RELAY_PORT_RANGE).toEqual({ begin: 49160, end: 49259 });
    expect(DEFAULT_TLS_PORT).toBe(9443);
    expect(DEFAULT_PUBLIC_HTTPS_PORT).toBe(443);
  });
});

describe('portPlanForRole', () => {
  test('node requires peer + rtc and omits public-https / turn / gateway', () => {
    const specs = portPlanForRole('node', live());
    expect(purposes(specs)).toEqual(['peer-signaling', 'rtc-ice']);
    expect(requiredByPurpose(specs)).toEqual({ 'peer-signaling': true, 'rtc-ice': true });
    expect(specs[0]).toMatchObject({
      proto: 'tcp',
      port: DEFAULT_PEER_PORT,
      envKey: 'VIBETERM_PEER_PORT',
      requiredFor: 'lan-direct',
    });
    expect(specs[1]).toMatchObject({
      proto: 'udp',
      range: { begin: 40000, end: 40099 },
      envKey: 'VIBETERM_RTC_PORT_RANGE',
      requiredFor: 'wan-direct',
    });
  });

  test('hub,node is node plus required public-https (443 when live port is null)', () => {
    const specs = portPlanForRole('hub,node', live());
    expect(purposes(specs)).toEqual(['public-https', 'peer-signaling', 'rtc-ice']);
    expect(requiredByPurpose(specs)).toEqual({
      'public-https': true,
      'peer-signaling': true,
      'rtc-ice': true,
    });
    expect(specs[0]).toMatchObject({
      proto: 'tcp',
      port: DEFAULT_PUBLIC_HTTPS_PORT,
      requiredFor: 'public-entry',
    });
  });

  test('relay requires public-https + turn control/relay and omits peer/rtc', () => {
    const specs = portPlanForRole('relay', live());
    expect(purposes(specs)).toEqual(['public-https', 'turn-control', 'turn-relay']);
    expect(requiredByPurpose(specs)).toEqual({
      'public-https': true,
      'turn-control': true,
      'turn-relay': true,
    });
    expect(specs[1]).toMatchObject({
      proto: 'udp',
      port: DEFAULT_TURN_PORT,
      envKey: 'VIBETERM_TURN_PORT',
      requiredFor: 'turn-fallback',
    });
    expect(specs[2]).toMatchObject({
      proto: 'udp',
      range: { begin: 49160, end: 49259 },
      envKey: 'VIBETERM_TURN_RELAY_PORT_RANGE',
      requiredFor: 'turn-fallback',
    });
  });

  test('relay,node is the union, ordered public-https → peer → rtc → turn', () => {
    const specs = portPlanForRole('relay,node', live());
    expect(purposes(specs)).toEqual([
      'public-https',
      'peer-signaling',
      'rtc-ice',
      'turn-control',
      'turn-relay',
    ]);
    expect(specs.every((spec) => spec.required)).toBe(true);
  });

  test('standalone lists peer/rtc as not required and nothing else', () => {
    const specs = portPlanForRole('standalone', live());
    expect(purposes(specs)).toEqual(['peer-signaling', 'rtc-ice']);
    expect(requiredByPurpose(specs)).toEqual({ 'peer-signaling': false, 'rtc-ice': false });
  });

  test('null rtcRange still fills DEFAULT_RTC_PORT_RANGE and keeps the env key', () => {
    const spec = portPlanForRole('node', live({ rtcRange: null })).find(
      (item) => item.purpose === 'rtc-ice'
    );
    expect(spec?.range).toEqual({ begin: 40000, end: 40099 });
    expect(spec?.envKey).toBe('VIBETERM_RTC_PORT_RANGE');
  });

  test('live values override defaults, including public-https and turn', () => {
    const specs = portPlanForRole(
      'relay,node',
      live({
        peerPort: 39002,
        rtcRange: { begin: 41000, end: 41099 },
        turnPort: 3479,
        turnRelayRange: { begin: 50000, end: 50099 },
        publicHttpsPort: 8443,
      })
    );
    expect(specs.find((item) => item.purpose === 'public-https')?.port).toBe(8443);
    expect(specs.find((item) => item.purpose === 'peer-signaling')?.port).toBe(39002);
    expect(specs.find((item) => item.purpose === 'rtc-ice')?.range).toEqual({
      begin: 41000,
      end: 41099,
    });
    expect(specs.find((item) => item.purpose === 'turn-control')?.port).toBe(3479);
    expect(specs.find((item) => item.purpose === 'turn-relay')?.range).toEqual({
      begin: 50000,
      end: 50099,
    });
  });

  test('gateway appears only when exposed, last in the list', () => {
    expect(purposes(portPlanForRole('node', live()))).not.toContain('gateway-http');
    const specs = portPlanForRole('node', live({ gatewayExposed: true, gatewayPort: 19663 }));
    expect(purposes(specs)).toEqual(['peer-signaling', 'rtc-ice', 'gateway-http']);
    expect(specs.at(-1)).toMatchObject({
      purpose: 'gateway-http',
      proto: 'tcp',
      port: 19663,
      envKey: 'GATEWAY_PORT',
      required: true,
      requiredFor: 'public-entry',
    });
  });

  test('exposed gateway is appended after the role union', () => {
    const specs = portPlanForRole('relay,node', live({ gatewayExposed: true }));
    expect(purposes(specs)).toEqual([
      'public-https',
      'peer-signaling',
      'rtc-ice',
      'turn-control',
      'turn-relay',
      'gateway-http',
    ]);
  });
});

describe('formatPortSpec / formatPortList', () => {
  test('formats a single port and a range', () => {
    expect(
      formatPortSpec({
        proto: 'tcp',
        port: DEFAULT_PEER_PORT,
        purpose: 'peer-signaling',
        requiredFor: 'lan-direct',
        required: true,
      })
    ).toBe('39001/tcp');
    expect(
      formatPortSpec({
        proto: 'udp',
        range: { ...DEFAULT_RTC_PORT_RANGE },
        purpose: 'rtc-ice',
        requiredFor: 'wan-direct',
        required: true,
      })
    ).toBe('40000-40099/udp');
  });

  test('joins specs in order', () => {
    expect(formatPortList(portPlanForRole('hub,node', live()))).toBe(
      '443/tcp, 39001/tcp, 40000-40099/udp'
    );
    expect(formatPortList(portPlanForRole('relay', live()))).toBe(
      '443/tcp, 3478/udp, 49160-49259/udp'
    );
    expect(formatPortList([])).toBe('');
  });
});

describe('parsePortRange', () => {
  test('accepts a strict ordered range in 1..65535', () => {
    expect(parsePortRange('40000-40099')).toEqual({ begin: 40000, end: 40099 });
    expect(parsePortRange('443-443')).toEqual({ begin: 443, end: 443 });
    expect(parsePortRange('1-65535')).toEqual({ begin: 1, end: 65535 });
    expect(parsePortRange(' 50000 - 50010 ')).toEqual({ begin: 50000, end: 50010 });
  });

  test('returns null for empty, malformed, reversed, and out-of-range text', () => {
    for (const text of [
      '',
      '   ',
      '40000',
      '40000-40099-1',
      '1.5-2',
      'a-b',
      '40000-40099/udp',
      '200-100',
      '0-100',
      '1-65536',
      '-1-10',
      '10-',
      '-10',
    ]) {
      expect(parsePortRange(text)).toBeNull();
    }
  });
});
