// 中继 tab 里与「本机自己就是中继」有关的两块：运营快照行、接入本机中继的入口。

import { describe, expect, test } from 'bun:test';
import type { UseMeshRelayResult } from '@/node/mesh-relay';
import type { LocalRelayStatus } from '@tmex/api-client/local/types';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RelayActionsController } from '../relay/use-relay-actions';
import { RelayUplinkPanel } from './relay-uplink-panel';

const NO_UPLINK = {
  mode: 'none',
  relayMode: false,
  quota: null,
  tenantId: null,
  relays: [],
  ordered: [],
  attached: null,
  metaEpoch: 0,
  nodesViaRelay: 0,
  reauthRequired: false,
  writable: true,
  kicked: false,
  loading: false,
  error: null,
  loadedAt: null,
  unsupported: false,
  refresh: () => undefined,
} satisfies UseMeshRelayResult;

const IDLE_ACTIONS: RelayActionsController = {
  enroll: null,
  confirm: null,
  busy: false,
  error: null,
  openEnroll: () => undefined,
  closeEnroll: () => undefined,
  requestConfirm: () => undefined,
  dismissConfirm: () => undefined,
  submitEnroll: () => Promise.resolve(),
  runConfirm: () => Promise.resolve(),
  metaPending: [],
  retryMetaKey: () => Promise.resolve(),
};

function service(overrides: Partial<LocalRelayStatus> = {}): LocalRelayStatus {
  return {
    publicUrl: 'https://relay.example.com',
    hasPassword: true,
    tenantCount: 3,
    nodesOnline: 5,
    currentNodes: 7,
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof RelayUplinkPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <RelayUplinkPanel
      relay={NO_UPLINK}
      actions={IDLE_ACTIONS}
      standalone={false}
      localRole="relay,node"
      relayService={service()}
      {...props}
    />
  );
}

describe('本机中继运营快照', () => {
  test('中继角色：地址可复制，计数与口令状态都在', () => {
    const html = render();
    expect(html).toContain('data-testid="local-relay-service"');
    expect(html).toContain('data-testid="local-relay-service-url"');
    expect(html).toContain('https://relay.example.com');
    expect(html).toContain('data-testid="local-relay-service-stats"');
    expect(html).toContain('data-testid="local-relay-service-password"');
    expect(html).toContain('relay.admin.password.set');
  });

  test('没设口令时明示未设置', () => {
    expect(render({ relayService: service({ hasPassword: false }) })).toContain(
      'relay.admin.password.unset'
    );
  });

  test('公网地址缺失时不渲染复制块', () => {
    const html = render({ relayService: service({ publicUrl: null }) });
    expect(html).toContain('data-testid="local-relay-service-unset"');
    expect(html).not.toContain('data-testid="local-relay-service-url"');
  });

  test('非中继角色不渲染快照', () => {
    const html = render({ localRole: 'node', relayService: null });
    expect(html).not.toContain('data-testid="local-relay-service"');
  });

  test('后端还没给快照时同样不渲染', () => {
    expect(render({ relayService: null })).not.toContain('data-testid="local-relay-service"');
  });
});

describe('接入本机中继', () => {
  test('中继角色且没有上级链路：专用入口与通用「接入中继」并存', () => {
    const html = render();
    expect(html).toContain('data-testid="nodes-relay-self-entry"');
    expect(html).toContain('data-testid="nodes-relay-enroll-self"');
    expect(html).toContain('nodes.machine.relayServiceEnrollHint');
    expect(html).toContain('data-testid="nodes-relay-enroll"');
  });

  test('刚设置完中继：入口高亮', () => {
    expect(render({ selfRelayFollowUp: true })).toContain('bg-primary/10');
    expect(render({ selfRelayFollowUp: false })).toContain('bg-muted/60');
  });

  test('已经接上中继：只剩链路条与常规操作，不再劝接入', () => {
    const html = render({
      relay: { ...NO_UPLINK, mode: 'relay', relayMode: true },
    });
    expect(html).not.toContain('data-testid="nodes-relay-self-entry"');
    expect(html).toContain('data-testid="local-relay-service"');
  });

  test('非中继角色不给专用入口', () => {
    const html = render({ localRole: 'node', relayService: null });
    expect(html).not.toContain('data-testid="nodes-relay-self-entry"');
    expect(html).toContain('data-testid="nodes-relay-enroll"');
  });

  test('standalone 只渲染插槽', () => {
    const html = renderToStaticMarkup(
      <RelayUplinkPanel
        relay={NO_UPLINK}
        actions={IDLE_ACTIONS}
        standalone
        relaySetup={<p data-testid="relay-setup-slot">form</p>}
      />
    );
    expect(html).toContain('data-testid="local-uplink-relay-standalone"');
    expect(html).toContain('data-testid="relay-setup-slot"');
    expect(html).not.toContain('data-testid="local-relay-service"');
  });
});
