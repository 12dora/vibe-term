// 「成员密钥未送达」行标记：名单直接取宿主级中继 store（服务端真相），不从行的 props 传。

import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshRelayStateForTest, setMeshRelayStateForTest } from '@/node/mesh-relay';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import type { MeshPortReach } from '../port-reach';

installWindowStorage();

const { renderToStaticMarkup } = await import('react-dom/server');
const { MetaKeyLagTag, PausedTag, PortsWarning } = await import('./row-cells');

const LAGGING = 'aa'.repeat(16);
const FINE = 'bb'.repeat(16);

afterEach(() => resetMeshRelayStateForTest());

function lag(nodeId: string) {
  setMeshRelayStateForTest({
    mode: 'relay',
    metaKeyLagging: [{ nodeId, name: null, since: null, admitSeq: 4 }],
  });
}

describe('MetaKeyLagTag', () => {
  test('名单里的节点挂标记', () => {
    lag(LAGGING);
    const html = renderToStaticMarkup(<MetaKeyLagTag nodeId={LAGGING} />);
    expect(html).toContain(`nodes-meta-lag-${LAGGING}`);
    expect(html).toContain('relay.tenant.metaKey.lagging.rowTag');
  });

  test('不在名单里的节点什么都不渲染', () => {
    lag(LAGGING);
    expect(renderToStaticMarkup(<MetaKeyLagTag nodeId={FINE} />)).toBe('');
  });

  test('大小写不同的 node id 视为同一台', () => {
    lag(LAGGING.toUpperCase());
    expect(renderToStaticMarkup(<MetaKeyLagTag nodeId={LAGGING} />)).toContain('nodes-meta-lag-');
  });

  test('没有欠账时什么都不渲染', () => {
    expect(renderToStaticMarkup(<MetaKeyLagTag nodeId={LAGGING} />)).toBe('');
  });
});

describe('PausedTag', () => {
  test('渲染 nodes.status.paused', () => {
    expect(renderToStaticMarkup(<PausedTag />)).toContain('nodes.status.paused');
  });
});

describe('PortsWarning', () => {
  const blocked: MeshPortReach = {
    purpose: 'peer-signaling',
    proto: 'tcp',
    port: 39001,
    status: 'blocked',
  };
  const unknown: MeshPortReach = {
    purpose: 'rtc-ice',
    proto: 'udp',
    range: { begin: 40000, end: 40099 },
    status: 'unknown',
  };

  test('有 blocked 时给出清单与放行提示', () => {
    const html = renderToStaticMarkup(<PortsWarning nodeId="aa" ports={[blocked, unknown]} />);
    expect(html).toContain('nodes-ports-warning-aa');
    expect(html).toContain('nodes.ports.blocked');
    expect(html).toContain('nodes.ports.hint');
  });

  test('缺失或全 unknown 不渲染', () => {
    expect(renderToStaticMarkup(<PortsWarning nodeId="aa" />)).toBe('');
    expect(renderToStaticMarkup(<PortsWarning nodeId="aa" ports={null} />)).toBe('');
    expect(renderToStaticMarkup(<PortsWarning nodeId="aa" ports={[unknown]} />)).toBe('');
    expect(renderToStaticMarkup(<PortsWarning nodeId="aa" ports={[]} />)).toBe('');
  });
});
