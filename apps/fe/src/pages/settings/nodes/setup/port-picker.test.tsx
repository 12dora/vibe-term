// 端口选择器与探测提示的呈现：档位由地址里的端口决定，地址还没填时整组不可点。

import { describe, expect, test } from 'bun:test';
import type { LocalStatusResponse } from '@tmex/api-client/local/types';
import { installWindowStorage } from '@tmex/stores/test-utils';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { PortPicker } = await import('./port-picker');
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
