import { describe, expect, test } from 'bun:test';
import { deriveRoute, describePair, readSelectedPair } from './ice-stats';
import { statsReport } from './test-fakes';

function pairStats(options: {
  localType: string;
  remoteType: string;
  localAddress?: string;
  remoteAddress?: string;
  rtt?: number;
  withTransport?: boolean;
  extraPair?: boolean;
}) {
  const entries: Array<Record<string, unknown>> = [
    {
      id: 'L',
      type: 'local-candidate',
      candidateType: options.localType,
      address: options.localAddress ?? '192.168.1.2',
      protocol: 'udp',
    },
    {
      id: 'R',
      type: 'remote-candidate',
      candidateType: options.remoteType,
      address: options.remoteAddress ?? '192.168.1.3',
    },
    {
      id: 'P',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L',
      remoteCandidateId: 'R',
      currentRoundTripTime: options.rtt ?? 0.012,
    },
  ];
  if (options.extraPair) {
    entries.unshift({
      id: 'P0',
      type: 'candidate-pair',
      state: 'failed',
      localCandidateId: 'L',
      remoteCandidateId: 'R',
    });
  }
  if (options.withTransport) {
    entries.push({ id: 'T', type: 'transport', selectedCandidatePairId: 'P' });
  }
  return statsReport(entries);
}

describe('readSelectedPair', () => {
  test('优先按 transport.selectedCandidatePairId 定位候选对，rtt 秒转毫秒', () => {
    const pair = readSelectedPair(
      pairStats({ localType: 'host', remoteType: 'host', withTransport: true, rtt: 0.0345 })
    );
    expect(pair?.localCandidateType).toBe('host');
    expect(pair?.remoteCandidateType).toBe('host');
    expect(pair?.rttMs).toBeCloseTo(34.5, 3);
    expect(pair?.protocol).toBe('udp');
  });

  test('没有 transport 时回落到 nominated + succeeded 的候选对', () => {
    const pair = readSelectedPair(
      pairStats({ localType: 'srflx', remoteType: 'host', extraPair: true })
    );
    expect(pair?.localCandidateType).toBe('srflx');
  });

  test('没有任何候选对时返回 null', () => {
    expect(readSelectedPair(statsReport([{ id: 'T', type: 'transport' }]))).toBeNull();
  });

  test('多个 succeeded 时，明确 selected 的那对优先于「随便一个 succeeded」', () => {
    // 老浏览器不给 transport.selectedCandidatePairId / nominated，但会给 selected：
    // 先取第一条 succeeded 会显示根本没承载流量的候选类型（实际走 TURN 却显示 v4-p2p）。
    const report = statsReport([
      { id: 'L1', type: 'local-candidate', candidateType: 'srflx', address: '203.0.113.5' },
      { id: 'R1', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.7' },
      { id: 'L2', type: 'local-candidate', candidateType: 'relay', address: '203.0.113.9' },
      { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.4' },
      {
        id: 'PA',
        type: 'candidate-pair',
        state: 'succeeded',
        localCandidateId: 'L1',
        remoteCandidateId: 'R1',
      },
      {
        id: 'PB',
        type: 'candidate-pair',
        state: 'succeeded',
        selected: true,
        localCandidateId: 'L2',
        remoteCandidateId: 'R2',
      },
    ]);
    const pair = readSelectedPair(report);
    expect(pair?.localCandidateType).toBe('relay');
    expect(deriveRoute(pair)).toBe('turn');
  });

  test('nominated + succeeded 优先于 selected', () => {
    const report = statsReport([
      { id: 'L1', type: 'local-candidate', candidateType: 'host', address: '10.0.0.1' },
      { id: 'R1', type: 'remote-candidate', candidateType: 'host', address: '10.0.0.2' },
      { id: 'L2', type: 'local-candidate', candidateType: 'relay', address: '203.0.113.9' },
      { id: 'R2', type: 'remote-candidate', candidateType: 'srflx', address: '198.51.100.4' },
      {
        id: 'PA',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L1',
        remoteCandidateId: 'R1',
      },
      {
        id: 'PB',
        type: 'candidate-pair',
        state: 'succeeded',
        selected: true,
        localCandidateId: 'L2',
        remoteCandidateId: 'R2',
      },
    ]);
    expect(readSelectedPair(report)?.localCandidateType).toBe('host');
  });
});

describe('deriveRoute', () => {
  test('两端 host + IPv4 → lan', () => {
    expect(
      deriveRoute(readSelectedPair(pairStats({ localType: 'host', remoteType: 'host' })))
    ).toBe('lan');
  });

  test('IPv6 地址 → v6', () => {
    const stats = pairStats({
      localType: 'host',
      remoteType: 'host',
      localAddress: 'fe80::1',
      remoteAddress: 'fe80::2',
    });
    expect(deriveRoute(readSelectedPair(stats))).toBe('v6');
  });

  test('srflx 打洞成功 + IPv4 → v4-p2p', () => {
    const stats = pairStats({
      localType: 'srflx',
      remoteType: 'srflx',
      localAddress: '203.0.113.5',
      remoteAddress: '198.51.100.7',
    });
    expect(deriveRoute(readSelectedPair(stats))).toBe('v4-p2p');
  });

  test('任一端 relay → turn', () => {
    expect(
      deriveRoute(readSelectedPair(pairStats({ localType: 'relay', remoteType: 'srflx' })))
    ).toBe('turn');
    expect(
      deriveRoute(readSelectedPair(pairStats({ localType: 'host', remoteType: 'relay' })))
    ).toBe('turn');
  });

  test('无候选对 / 候选类型缺失 → null', () => {
    expect(deriveRoute(null)).toBeNull();
    expect(
      deriveRoute({
        localCandidateType: null,
        remoteCandidateType: null,
        localAddress: null,
        remoteAddress: null,
        protocol: null,
        rttMs: null,
      })
    ).toBeNull();
  });
});

describe('describePair', () => {
  test('输出 `host → srflx` 形式', () => {
    expect(
      describePair(readSelectedPair(pairStats({ localType: 'host', remoteType: 'srflx' })))
    ).toBe('host → srflx');
    expect(describePair(null)).toBeNull();
  });
});
