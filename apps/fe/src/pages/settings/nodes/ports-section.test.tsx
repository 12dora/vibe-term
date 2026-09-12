import { describe, expect, test } from 'bun:test';
import { portPlanOrFallback } from './port-reach';
import { PortsSection } from './ports-section';

const { renderToStaticMarkup } = await import('react-dom/server');

describe('PortsSection', () => {
  const plan = portPlanOrFallback(undefined, 'node');

  test('空计划不渲染', () => {
    expect(renderToStaticMarkup(<PortsSection plan={[]} />)).toBe('');
  });

  test('缺探测结果时点是 unknown，不算警告', () => {
    const html = renderToStaticMarkup(<PortsSection plan={plan} reach={null} />);
    expect(html).toContain('data-testid="local-machine-ports"');
    expect(html).toContain('localMachine.ports.title');
    expect(html).toContain('data-port-status="unknown"');
    expect(html).not.toContain('data-port-status="blocked"');
  });

  test('self 行 blocked / open 反映到对应点上', () => {
    const html = renderToStaticMarkup(
      <PortsSection
        plan={plan}
        reach={[
          { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'blocked' },
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
    expect(html).toContain('data-port-status="open"');
    expect(html).toContain('39001/tcp');
  });
});
