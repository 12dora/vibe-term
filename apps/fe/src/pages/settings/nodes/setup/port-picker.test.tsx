// 端口选择器与探测提示的呈现：档位由地址里的端口决定，地址还没填时整组不可点。

import { describe, expect, test } from 'bun:test';
import type { LocalStatusResponse } from '@vibeterm/api-client/local/types';
import { installWindowStorage } from '@vibeterm/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { PortPicker, customPortChange, modeChange, modeOf, parsePort } = await import(
  './port-picker'
);
const { AddressProbeNotice } = await import('./form-parts');
const { BecomeHubForm } = await import('./become-hub-form');
const { BecomeRelayForm } = await import('./become-relay-form');
const { JoinHubForm } = await import('./join-hub-form');
const { JoinRelayForm } = await import('./join-relay-form');

const SUGGESTED = 23443;

function picker(url: string): string {
  return renderToStaticMarkup(
    <PortPicker idPrefix="t" url={url} suggestedPort={SUGGESTED} onChange={() => undefined} />
  );
}

function selected(html: string, option: string): boolean {
  return html.includes(`data-testid="t-port-${option}" data-selected="true"`);
}

function status(overrides: Partial<LocalStatusResponse> = {}): LocalStatusResponse {
  return {
    role: 'standalone',
    nodeEnv: 'production',
    hubUrl: null,
    hubPublicUrl: null,
    direct: {
      supported: true,
      installed: false,
      enabled: true,
      capable: false,
      version: null,
      platform: 'darwin-arm64',
    },
    tls: { mode: 'none', listenerRunning: false, tlsPort: null },
    domainAccess: { allowed: true, viaDomain: false, hosts: [] },
    relay: null,
    ...overrides,
  };
}

describe('PortPicker', () => {
  test('没写端口与写了 443 都落在「标准」档', () => {
    for (const url of ['https://hub.example.com', 'https://hub.example.com:443']) {
      const html = picker(url);
      expect(selected(html, 'standard')).toBe(true);
      expect(html).not.toContain('data-testid="t-port-custom-input"');
    }
  });

  test('端口正好是建议值时落在「建议」档', () => {
    const html = picker(`https://hub.example.com:${SUGGESTED}`);
    expect(selected(html, 'suggested')).toBe(true);
    expect(selected(html, 'standard')).toBe(false);
  });

  test('其它端口落在「自定义」档并把端口填进输入框', () => {
    const html = picker('https://hub.example.com:9443');
    expect(selected(html, 'custom')).toBe(true);
    expect(html).toContain('data-testid="t-port-custom"');
    expect(html).toContain('value="9443"');
  });

  test('地址还没填时整组不可点', () => {
    const html = picker('');
    expect(html).toContain('disabled=""');
    expect(html).toContain('pointer-events-none');
  });

  test('自定义输入框是受控的：显示的端口就是地址里的端口', () => {
    expect(picker('https://hub.example.com:9443')).toContain('value="9443"');
    // 地址那头改了端口，输入框跟着显示新端口（受控值来自地址，不是一次性的默认值）
    expect(picker('https://hub.example.com:8443')).toContain('value="8443"');
    expect(picker('https://hub.example.com:8443')).not.toContain('value="9443"');
  });
});

describe('自定义端口的判定', () => {
  test('合法端口收下，空、非数字与越界一律不认', () => {
    expect(parsePort('8443')).toBe(8443);
    expect(parsePort(' 1 ')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('')).toBeNull();
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
    expect(parsePort('84a')).toBeNull();
    expect(parsePort('-1')).toBeNull();
  });

  test('填坏了就报错且不动地址——绝不悄悄沿用上一个端口', () => {
    const url = 'https://hub.example.com:9443';
    expect(customPortChange(url, '8443')).toEqual({
      url: 'https://hub.example.com:8443',
      error: null,
    });
    for (const bad of ['', '65536', '0', 'abc']) {
      expect(customPortChange(url, bad)).toEqual({
        url,
        error: 'nodes.setup.errors.invalid_port',
      });
    }
  });

  test('切档位：标准清端口、建议写建议端口、自定义按草稿定错误', () => {
    const url = 'https://hub.example.com:9443';
    expect(modeChange(url, 'standard', SUGGESTED, '9443')).toEqual({
      url: 'https://hub.example.com',
      error: null,
    });
    expect(modeChange(url, 'suggested', SUGGESTED, '9443')).toEqual({
      url: `https://hub.example.com:${SUGGESTED}`,
      error: null,
    });
    // 从「标准」切到「自定义」时端口还没定：这是一条待修的错误，不是沿用旧端口
    expect(modeChange('https://hub.example.com', 'custom', SUGGESTED, '')).toEqual({
      url: 'https://hub.example.com',
      error: 'nodes.setup.errors.invalid_port',
    });
    expect(modeChange(url, 'custom', SUGGESTED, '9443')).toEqual({ url, error: null });
  });

  test('档位按地址里的端口推断，「自定义」记号只在用户亲手点过时生效', () => {
    expect(modeOf(null, SUGGESTED, false)).toBe('standard');
    expect(modeOf(443, SUGGESTED, false)).toBe('standard');
    expect(modeOf(SUGGESTED, SUGGESTED, false)).toBe('suggested');
    expect(modeOf(9443, SUGGESTED, false)).toBe('custom');
    expect(modeOf(null, SUGGESTED, true)).toBe('custom');
  });
});

describe('AddressProbeNotice', () => {
  test('三态各有各的提示，idle 什么都不渲染', () => {
    const idle = renderToStaticMarkup(
      <AddressProbeNotice state={{ phase: 'idle', port: null }} kind="hub" testId="p" />
    );
    expect(idle).toBe('');

    const probing = renderToStaticMarkup(
      <AddressProbeNotice state={{ phase: 'probing', port: null }} kind="hub" testId="p" />
    );
    expect(probing).toContain('data-testid="p-probing"');
    expect(probing).toContain('nodes.setup.probe.probing');

    const resolved = renderToStaticMarkup(
      <AddressProbeNotice state={{ phase: 'resolved', port: 13443 }} kind="relay" testId="p" />
    );
    expect(resolved).toContain('data-testid="p-resolved"');
    expect(resolved).toContain('nodes.setup.probe.resolvedRelay');

    const failed = renderToStaticMarkup(
      <AddressProbeNotice state={{ phase: 'failed', port: null }} kind="hub" testId="p" />
    );
    expect(failed).toContain('data-testid="p-failed"');
    expect(failed).toContain('nodes.setup.probe.failed');
  });

  test('Hub 与中继的探到文案分开', () => {
    const hub = renderToStaticMarkup(
      <AddressProbeNotice state={{ phase: 'resolved', port: 13443 }} kind="hub" testId="p" />
    );
    expect(hub).toContain('nodes.setup.probe.resolvedHub');
  });
});

describe('表单接线', () => {
  test('「本机作为 Hub」带端口选择器，且按预填地址选中档位', () => {
    const html = renderToStaticMarkup(
      <BecomeHubForm
        localStatus={status()}
        origin={`https://hub.example.com:${SUGGESTED}`}
        suggestedPort={SUGGESTED}
      />
    );
    expect(html).toContain('data-testid="setup-hub-port-mode"');
    expect(html).toContain('data-testid="setup-hub-port-suggested" data-selected="true"');
  });

  test('「本机作为中继」带端口选择器', () => {
    const html = renderToStaticMarkup(
      <BecomeRelayForm
        localStatus={status()}
        origin="https://relay.example.com"
        suggestedPort={SUGGESTED}
      />
    );
    expect(html).toContain('data-testid="setup-relay-port-mode"');
    expect(html).toContain('data-testid="setup-relay-port-standard" data-selected="true"');
  });

  test('两个加入表单初始不显示探测提示', () => {
    const hub = renderToStaticMarkup(<JoinHubForm localStatus={status()} hostname="studio" />);
    expect(hub).toContain('id="setup-hub-url"');
    expect(hub).not.toContain('setup-join-hub-probe');

    const relay = renderToStaticMarkup(<JoinRelayForm localStatus={status()} hostname="studio" />);
    expect(relay).toContain('id="setup-relay-url"');
    expect(relay).not.toContain('setup-join-relay-probe');
  });
});
