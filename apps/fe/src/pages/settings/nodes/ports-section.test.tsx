import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshNodesStateForTest } from '@/node/mesh-nodes';
import { portPlanOrFallback } from './port-reach';
import { PortsSection, portDotTitle, runPortsProbe } from './ports-section';

const { renderToStaticMarkup } = await import('react-dom/server');

afterEach(() => resetMeshNodesStateForTest());

describe('PortsSection', () => {
  const plan = portPlanOrFallback(undefined, 'node');
  const hubPlan = portPlanOrFallback(undefined, 'hub,node');

  test('空计划不渲染', () => {
    expect(renderToStaticMarkup(<PortsSection plan={[]} />)).toBe('');
  });

  test('缺探测行时画灰点 unknown，不是破折号', () => {
    const html = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(html).toContain('data-testid="local-machine-ports"');
    expect(html).toContain('localMachine.ports.titleNode');
    expect(html).toContain('localMachine.ports.legend');
    expect(html).toContain('data-port-status="unknown"');
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('localMachine.ports.notProbedTitle');
    expect(html).not.toMatch(/>localMachine\.ports\.notProbed</);
    expect(html).not.toContain('data-port-status="blocked"');
    expect(html).not.toContain('ring-2');
  });

  test('标题随角色变化', () => {
    expect(
      renderToStaticMarkup(<PortsSection plan={plan} reach={null} localRole="node" />)
    ).toContain('localMachine.ports.titleNode');
    expect(
      renderToStaticMarkup(<PortsSection plan={hubPlan} reach={null} localRole="hub,node" />)
    ).toContain('localMachine.ports.titleHub');
    expect(
      renderToStaticMarkup(<PortsSection plan={plan} reach={null} localRole="relay,node" />)
    ).toContain('localMachine.ports.titleRelay');
  });

  test('self 行 blocked / open 反映到对应点上，blocked 不带 ring', () => {
    const html = renderToStaticMarkup(
      <PortsSection
        plan={plan}
        reach={[
          {
            purpose: 'peer-signaling',
            proto: 'tcp',
            port: 39001,
            status: 'blocked',
            code: 'peer_refused',
          },
          {
            purpose: 'rtc-ice',
            proto: 'udp',
            range: { begin: 40000, end: 40099 },
            status: 'open',
          },
        ]}
      />
    );
    expect(html).toContain('data-testid="local-port-peer-signaling"');
    expect(html).toContain('data-port-status="blocked"');
    expect(html).toContain('data-status="blocked"');
    expect(html).toContain('bg-destructive');
    expect(html).not.toContain('ring-2');
    expect(html).toContain('data-port-status="open"');
    expect(html).toContain('data-status="open"');
    expect(html).toContain('bg-emerald-500');
    expect(html).toContain('39001/tcp');
    expect(html).toContain('nodes.ports.status.blocked');
    expect(html).toContain('nodes.ports.code.peer_refused');
  });

  test('计划里没有 reach 行的用途画灰点 unknown，有 reach 的才按 status 着色', () => {
    const html = renderToStaticMarkup(
      <PortsSection
        plan={hubPlan}
        localRole="hub,node"
        reach={[{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' }]}
      />
    );
    expect(html).toContain('data-testid="local-port-public-https"');
    expect(html).toContain('data-status="open"');
    const httpsRow = html.slice(
      html.indexOf('data-testid="local-port-public-https"'),
      html.indexOf('data-testid="local-port-peer-signaling"')
    );
    expect(httpsRow).toContain('data-status="unknown"');
    expect(httpsRow).toContain('data-port-status="unknown"');
    expect(httpsRow).toContain('localMachine.ports.notProbedTitle');
    expect(httpsRow).not.toMatch(/>localMachine\.ports\.notProbed</);
    expect(httpsRow).not.toContain('data-status="open"');
  });

  test('有 self 时给出重新检测；busy 时转圈并禁用', () => {
    const idle = renderToStaticMarkup(<PortsSection plan={plan} reach={null} selfNodeId="abc" />);
    expect(idle).toContain('data-testid="local-machine-ports-recheck"');
    expect(idle).toContain('nodes.ports.recheck');
    expect(idle).not.toContain('disabled=""');

    const busy = renderToStaticMarkup(
      <PortsSection plan={plan} reach={null} selfNodeId="abc" busy />
    );
    expect(busy).toContain('disabled=""');
    expect(busy).toContain('animate-spin');
  });

  test('没有 self 时不画重新检测', () => {
    const html = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(html).not.toContain('data-testid="local-machine-ports-recheck"');
  });

  test('探测失败时给出错误行', () => {
    const html = renderToStaticMarkup(
      <PortsSection plan={plan} reach={null} selfNodeId="abc" error="boom" />
    );
    expect(html).toContain('data-testid="local-machine-ports-error"');
    expect(html).toContain('boom');
  });
});

describe('portDotTitle', () => {
  const t = (key: string) => key;

  test('blocked 带上原因码，其它状态只有 status', () => {
    expect(
      portDotTitle(t, {
        purpose: 'peer-signaling',
        proto: 'tcp',
        port: 39001,
        status: 'blocked',
        code: 'peer_timeout',
      })
    ).toBe('nodes.ports.status.blocked · nodes.ports.code.peer_timeout');
    expect(
      portDotTitle(t, { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' })
    ).toBe('nodes.ports.status.open');
  });
});

describe('runPortsProbe', () => {
  test('成功时解析 ports；失败带回错误文案', async () => {
    const ok = await runPortsProbe('n1', async () => ({
      ports: [{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' }],
    }));
    expect(ok).toEqual({
      ok: true,
      ports: [{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' }],
    });
    const fail = await runPortsProbe('n1', async () => {
      throw new Error('offline');
    });
    expect(fail).toEqual({ ok: false, error: 'offline' });
  });
});
