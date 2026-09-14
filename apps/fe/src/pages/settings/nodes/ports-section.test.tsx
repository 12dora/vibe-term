import { afterEach, describe, expect, test } from 'bun:test';
import { resetMeshNodesStateForTest } from '@/node/mesh-nodes';
import { portPlanOrFallback } from './port-reach';
import { PortsSection, portDotTitle, runPortsProbe } from './ports-section';

const { renderToStaticMarkup } = await import('react-dom/server');

afterEach(() => resetMeshNodesStateForTest());

describe('PortsSection', () => {
  const plan = portPlanOrFallback(undefined, 'node');
  const relayNodePlan = portPlanOrFallback(undefined, 'relay,node');

  test('空计划不渲染', () => {
    expect(renderToStaticMarkup(<PortsSection plan={[]} />)).toBe('');
  });

  test('缺探测行时画灰点 unknown，不是破折号', () => {
    const html = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(html).toContain('data-testid="local-machine-ports"');
    expect(html).toContain('nodes.ports.label');
    // 图例撤了：三态只由灯自己的 title / aria-label 说明
    expect(html).not.toContain('data-testid="local-machine-ports-legend"');
    expect(html).not.toContain('localMachine.ports.legend');
    expect(html).toContain('data-port-status="unknown"');
    expect(html).toContain('data-status="unknown"');
    expect(html).toContain('localMachine.ports.notProbedTitle');
    expect(html).not.toMatch(/>localMachine\.ports\.notProbed</);
    expect(html).not.toContain('data-port-status="blocked"');
    expect(html).not.toContain('ring-2');
  });

  test('标签不再随角色变化，端口条目跟着计划走', () => {
    const node = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(node).toContain('nodes.ports.label');
    expect(node).not.toContain('data-testid="local-port-public-https"');
    const relayNode = renderToStaticMarkup(<PortsSection plan={relayNodePlan} reach={null} />);
    expect(relayNode).toContain('nodes.ports.label');
    expect(relayNode).toContain('data-testid="local-port-public-https"');
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

  test('只有 blocked 配一句可见的「未开通」，open 与 unknown 仍然只有灯', () => {
    const html = renderToStaticMarkup(
      <PortsSection
        plan={plan}
        reach={[
          { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' },
          { purpose: 'rtc-ice', proto: 'udp', range: { begin: 40000, end: 40099 }, status: 'open' },
        ]}
      />
    );
    expect(html).toContain('data-testid="local-port-blocked-peer-signaling"');
    expect(html).toContain('localMachine.ports.blocked');
    expect(html).not.toContain('data-testid="local-port-blocked-rtc-ice"');

    const unknown = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(unknown).not.toContain('data-testid="local-port-blocked-peer-signaling"');
    expect(unknown).not.toContain('localMachine.ports.blocked');
  });

  test('计划里没有 reach 行的用途画灰点 unknown，有 reach 的才按 status 着色', () => {
    const html = renderToStaticMarkup(
      <PortsSection
        plan={relayNodePlan}
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

  test('TURN 控制口与中继段并成一行，探测取更坏的那一段', () => {
    const relayPlan = portPlanOrFallback(undefined, 'relay');
    const html = renderToStaticMarkup(
      <PortsSection
        plan={relayPlan}
        reach={[
          { purpose: 'turn-control', proto: 'udp', port: 40000, status: 'open' },
          {
            purpose: 'turn-relay',
            proto: 'udp',
            range: { begin: 40001, end: 40049 },
            status: 'blocked',
          },
        ]}
      />
    );
    expect(html).toContain('data-testid="local-port-turn-control"');
    expect(html).not.toContain('data-testid="local-port-turn-relay"');
    expect(html).toContain('40000-40049/udp');
    expect(html).not.toContain('40001-40049/udp');
    expect(html).toContain('data-testid="local-port-blocked-turn-control"');
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
