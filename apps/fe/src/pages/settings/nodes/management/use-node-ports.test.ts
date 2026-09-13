import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { parsePortReachList } from '../port-reach';
import { nextPortsSync, portsInitialSnapshot, useNodePorts } from './use-node-ports';

const OPEN = {
  purpose: 'peer-signaling' as const,
  proto: 'tcp' as const,
  port: 39001,
  status: 'open' as const,
};

describe('probe 回包解析', () => {
  test('探测结果走同一套解析：畸形条目丢掉，合法条目留下', () => {
    expect(
      parsePortReachList([
        { purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' },
        { purpose: 'rtc-ice', proto: 'udp', status: 'nope' },
      ])
    ).toEqual([{ purpose: 'peer-signaling', proto: 'tcp', port: 39001, status: 'open' }]);
  });
});

describe('useNodePorts 按值同步', () => {
  test('等值但每次都是新数组：连续渲染不会触发同步（避免更新循环）', () => {
    const snapshot = portsInitialSnapshot([{ ...OPEN }]);
    for (let i = 0; i < 40; i++) {
      expect(nextPortsSync('n1', [{ ...OPEN }], 'n1', snapshot, false)).toBeNull();
    }
  });

  test('行数据刷新（值变了）且未在探测：同步 ports', () => {
    const prev = portsInitialSnapshot([{ ...OPEN }]);
    const next = [{ ...OPEN, status: 'blocked' as const }];
    const patch = nextPortsSync('n1', next, 'n1', prev, false);
    expect(patch?.updatePorts).toBe(true);
    expect(patch?.ports).toEqual(next);
    expect(patch?.resetError).toBe(false);
  });

  test('探测进行中只记下快照，不覆盖探测结果', () => {
    const prev = portsInitialSnapshot([{ ...OPEN }]);
    const next = [{ ...OPEN, status: 'blocked' as const }];
    const patch = nextPortsSync('n1', next, 'n1', prev, true);
    expect(patch?.updatePorts).toBe(false);
    expect(patch?.seenSnapshot).toBe(portsInitialSnapshot(next));
  });

  test('换节点：重置 ports 与错误', () => {
    const patch = nextPortsSync('n2', [{ ...OPEN }], 'n1', 'old', false);
    expect(patch?.resetError).toBe(true);
    expect(patch?.updatePorts).toBe(true);
    expect(patch?.seenId).toBe('n2');
  });

  test('挂载 hook：每次 render 传入新数组也不会陷入更新循环', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    function Probe() {
      const { ports } = useNodePorts('n1', [{ ...OPEN }]);
      return createElement('span', { 'data-count': String(ports?.length ?? 0) });
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-count="1"');
  });
});
